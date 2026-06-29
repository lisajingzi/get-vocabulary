/**
 * POST /api/ai/derived
 *
 * Some entries in the bundled Oxford 9 mdx are stored as cross-ref aliases
 * pointing at a base lemma — e.g. `arousal` → `arouse` — without their own
 * phonetics, part-of-speech, definition or examples. The dictionary UI
 * still wants to show what the user actually typed (`arousal`), so this
 * endpoint asks an LLM to fill in the gap: pos / phonetics / Chinese gloss
 * / English definition / a couple of example sentences for the derived
 * form itself, given the base lemma as grounding context.
 *
 * Request body:
 *   {
 *     derived: "arousal",
 *     base:    "arouse",
 *     baseSense?: { def?: string; chn?: string; pos?: string }
 *   }
 *
 * Response body:
 *   {
 *     pos:      string,   // e.g. "noun"
 *     phonUk?:  string,   // IPA without the surrounding slashes
 *     phonUs?:  string,
 *     def:      string,   // English definition of the derived form
 *     chn:      string,   // Chinese gloss
 *     examples: Array<{ en: string; cn: string }>,   // 1..2 sentences
 *     provider: "deepseek" | "mock",
 *   }
 *
 * Mirrors `/api/ai/example` in shape and fallback behaviour: if there is no
 * DEEPSEEK_API_KEY configured we return a deterministic mock so the UI is
 * still exercisable end-to-end.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";

interface BaseSenseHint {
  def?: string;
  chn?: string;
  pos?: string;
}

interface RequestBody {
  derived: string;
  base: string;
  baseSense?: BaseSenseHint;
}

interface ResponseBody {
  pos: string;
  phonUk?: string;
  phonUs?: string;
  def: string;
  chn: string;
  examples: Array<{ en: string; cn: string }>;
  provider: "deepseek" | "mock";
}

/** See /api/ai/correct for rationale. */
function resolveChatUrl(): string {
  const raw = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(raw)) return raw;
  if (/\/v\d+$/.test(raw)) return `${raw}/chat/completions`;
  return `${raw}/v1/chat/completions`;
}
const CHAT_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

function buildPrompt(
  derived: string,
  base: string,
  baseSense?: BaseSenseHint,
): string {
  const baseLine = baseSense?.def
    ? `Base lemma "${base}" means: "${baseSense.def}"${
        baseSense.chn ? ` (中文: ${baseSense.chn})` : ""
      }${baseSense.pos ? ` [${baseSense.pos}]` : ""}.`
    : `Base lemma is "${base}".`;
  return [
    "You are an English lexicographer assisting a Chinese learner.",
    `Target word: "${derived}". It is derived from the base lemma "${base}".`,
    baseLine,
    `Provide the dictionary information of "${derived}" itself (NOT of "${base}").`,
    "Constraints:",
    "- `pos` must be the part of speech of the derived form (e.g. noun, adjective, adverb).",
    "- `phonUk` and `phonUs` must be IPA WITHOUT surrounding slashes (e.g. \"əˈraʊzl\"). Omit a key if you are not confident.",
    "- `def` is a concise English definition of the derived form, 6–18 words.",
    "- `chn` is a faithful Chinese gloss, 1–3 short comma-separated phrases.",
    "- `examples` is an array of 1 to 2 objects each with `en` (12–22 words, natural CEFR B2) and `cn` (faithful Chinese translation). The English sentence MUST contain the derived form (`" + derived + "`).",
    "Reply with ONLY a JSON object, no markdown fences, in this exact shape:",
    '{ "pos": "...", "phonUk": "...", "phonUs": "...", "def": "...", "chn": "...", "examples": [ { "en": "...", "cn": "..." } ] }',
  ].join("\n");
}

/** Pull the first balanced JSON object out of arbitrary model output. */
function extractJson(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (c === "\\") {
        esc = true;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function mockResult(
  derived: string,
  base: string,
  baseSense?: BaseSenseHint,
): ResponseBody {
  // Make the mock visibly different from the base so devs can tell at a
  // glance that the panel is wired to *this* endpoint and not to the
  // canonical entry's content.
  const basePos = baseSense?.pos ?? "verb";
  const guessedPos =
    basePos.startsWith("verb")
      ? "noun"
      : basePos.startsWith("noun")
        ? "adjective"
        : "noun";
  return {
    pos: guessedPos,
    def: `(mock) the ${guessedPos} form related to "${base}".`,
    chn: `(模拟) 与"${base}"相关的${guessedPos === "noun" ? "名词" : guessedPos === "adjective" ? "形容词" : "派生形式"}。`,
    examples: [
      {
        en: `Her ${derived} grew steadily as the story unfolded.`,
        cn: `随着故事展开，她的"${derived}"逐渐增强。`,
      },
    ],
    provider: "mock",
  };
}

async function callDeepseek(
  derived: string,
  base: string,
  baseSense: BaseSenseHint | undefined,
  apiKey: string,
): Promise<ResponseBody> {
  const prompt = buildPrompt(derived, base, baseSense);
  const res = await fetch(resolveChatUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      max_tokens: 480,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`deepseek ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const jsonStr = extractJson(content);
  if (!jsonStr)
    throw new Error(`deepseek returned non-JSON: ${content.slice(0, 200)}`);
  const parsed = JSON.parse(jsonStr) as Partial<ResponseBody> & {
    examples?: Array<{ en?: unknown; cn?: unknown }>;
  };
  const pos = String(parsed.pos ?? "").trim();
  const def = String(parsed.def ?? "").trim();
  const chn = String(parsed.chn ?? "").trim();
  if (!pos || !def) throw new Error("deepseek returned incomplete payload");
  const phonUk = parsed.phonUk
    ? String(parsed.phonUk).replace(/^\/|\/$/g, "").trim() || undefined
    : undefined;
  const phonUs = parsed.phonUs
    ? String(parsed.phonUs).replace(/^\/|\/$/g, "").trim() || undefined
    : undefined;
  const rawExamples = Array.isArray(parsed.examples) ? parsed.examples : [];
  const examples = rawExamples
    .map((ex) => ({
      en: String(ex?.en ?? "").trim(),
      cn: String(ex?.cn ?? "").trim(),
    }))
    .filter((ex) => ex.en.length > 0)
    .slice(0, 2);
  return {
    pos,
    phonUk,
    phonUs,
    def,
    chn,
    examples,
    provider: "deepseek",
  };
}

export async function POST(req: Request): Promise<Response> {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const derived = String(body.derived ?? "")
    .trim()
    .toLowerCase();
  const base = String(body.base ?? "")
    .trim()
    .toLowerCase();
  const re = /^[a-z][a-z\-'\s]{0,40}$/;
  if (!re.test(derived) || !re.test(base)) {
    return NextResponse.json(
      { error: "invalid derived/base" },
      { status: 400 },
    );
  }
  if (derived === base) {
    return NextResponse.json(
      { error: "derived must differ from base" },
      { status: 400 },
    );
  }
  const baseSense = body.baseSense;

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return NextResponse.json(mockResult(derived, base, baseSense));
  }

  try {
    const result = await callDeepseek(derived, base, baseSense, apiKey);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[ai/derived] deepseek call failed:", err);
    const fallback = mockResult(derived, base, baseSense);
    return NextResponse.json({ ...fallback, provider: "mock" });
  }
}
