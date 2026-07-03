/**
 * POST /api/ai/phrase
 *
 * Ask DeepSeek to generate a rich dictionary-like explanation for an
 * English phrase / idiom (e.g. "take advantage of", "by the way").
 * Called ONCE per phrase from /notebook/phrase/[slug]; the caller caches
 * the result on the notebook entry and never re-hits this endpoint for
 * the same phrase.
 *
 * Request body:
 *   { phrase: "take advantage of" }
 *
 * Response body (all keys except examples/def/chn are optional):
 *   {
 *     posHint?:      "verb phrase" | "prep phrase" | "idiom" | ...
 *     def:            string,          // English definition, one sentence
 *     chn:            string,          // Chinese gloss
 *     examples:       Array<{ en: string; cn: string }>,   // 3-5 items
 *     collocations?:  string[],        // common collocations
 *     synonyms?:      string[],        // near-synonymous phrases
 *     notes?:         string,          // usage / register hints
 *     provider:       "deepseek" | "mock"
 *   }
 *
 * Falls back to a deterministic mock when DEEPSEEK_API_KEY is missing so
 * the notebook UI is fully exercisable during local dev.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";

interface RequestBody {
  phrase: string;
}

interface ResponseBody {
  posHint?: string;
  def: string;
  chn: string;
  examples: Array<{ en: string; cn: string }>;
  collocations?: string[];
  synonyms?: string[];
  notes?: string;
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

function buildPrompt(phrase: string): string {
  return [
    "You are an English lexicographer assisting a Chinese learner at CEFR B2.",
    `Target phrase: "${phrase}".`,
    "Produce a detailed, notebook-style explanation of this phrase / idiom.",
    "Constraints — read carefully:",
    "- `posHint` is a short label describing what kind of phrase it is",
    "  (e.g. \"verb phrase\", \"prepositional phrase\", \"idiom\", \"discourse marker\").",
    "- `def` is a concise English definition, ONE sentence, 8–20 words.",
    "- `chn` is a faithful, natural-sounding Chinese gloss —",
    "  1–3 short comma-separated phrases, no full sentences.",
    "- `examples` MUST contain 3 to 5 items. Each item has `en` (10–22 words,",
    "  a natural everyday sentence a native speaker would plausibly say)",
    "  and `cn` (faithful Chinese translation). The English sentence MUST",
    "  contain the target phrase in its natural form (allow normal grammatical",
    "  inflection, e.g. -ing / -ed / plural of any nouns inside).",
    "  Cover at least two distinct scenarios (work / daily life / news / study).",
    "- `collocations` is an array of 3–6 common surrounding patterns or",
    "  fixed collocations (e.g. \"take full advantage of\", \"take unfair",
    "  advantage of\"). Return \"\" or omit the field if none apply.",
    "- `synonyms` is an array of 2–5 near-synonymous phrases or single-word",
    "  equivalents (e.g. \"make use of\", \"exploit\").",
    "- `notes` is a short usage tip: register (formal / informal / spoken),",
    "  common learner mistakes, negative connotations, etc. Keep under 40 words.",
    "  Chinese preferred, but bilingual mixing is fine when a term is inherently English.",
    "Reply with ONLY a JSON object, no markdown fences, in this exact shape:",
    '{ "posHint": "...", "def": "...", "chn": "...",',
    '  "examples": [ { "en": "...", "cn": "..." } ],',
    '  "collocations": ["..."], "synonyms": ["..."], "notes": "..." }',
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

function mockResult(phrase: string): ResponseBody {
  // Deterministic offline mock. Marked provider:"mock" so the client can
  // (optionally) show a "模拟数据" tag until the real key lands.
  return {
    posHint: "phrase",
    def: `(mock) A common English phrase equivalent to "${phrase}".`,
    chn: `(模拟) 与"${phrase}"含义相近的常用英语短语。`,
    examples: [
      {
        en: `In everyday conversation, people often use "${phrase}" to describe a common situation.`,
        cn: `在日常对话中，人们常用"${phrase}"来描述一种常见情境。`,
      },
      {
        en: `Writers may also employ "${phrase}" in fiction to make the dialogue sound natural.`,
        cn: `作者也可能在小说中使用"${phrase}"，让对话更加自然。`,
      },
      {
        en: `News articles use "${phrase}" when explaining trends to a general audience.`,
        cn: `新闻文章在向大众解释趋势时会使用"${phrase}"。`,
      },
    ],
    collocations: [`really ${phrase}`, `often ${phrase}`],
    synonyms: ["(mock synonym 1)", "(mock synonym 2)"],
    notes: "（模拟）常见于口语与非正式书面语。",
    provider: "mock",
  };
}

async function callDeepseek(
  phrase: string,
  apiKey: string,
): Promise<ResponseBody> {
  const prompt = buildPrompt(phrase);
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
      max_tokens: 900,
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
    collocations?: unknown[];
    synonyms?: unknown[];
  };
  const def = String(parsed.def ?? "").trim();
  const chn = String(parsed.chn ?? "").trim();
  if (!def || !chn) throw new Error("deepseek returned incomplete payload");
  const rawExamples = Array.isArray(parsed.examples) ? parsed.examples : [];
  const examples = rawExamples
    .map((ex) => ({
      en: String(ex?.en ?? "").trim(),
      cn: String(ex?.cn ?? "").trim(),
    }))
    .filter((ex) => ex.en.length > 0)
    .slice(0, 5);
  if (examples.length === 0) {
    throw new Error("deepseek returned no examples");
  }
  const asStringArray = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const cleaned = v
      .map((x) => String(x ?? "").trim())
      .filter((x) => x.length > 0)
      .slice(0, 8);
    return cleaned.length > 0 ? cleaned : undefined;
  };
  return {
    posHint: parsed.posHint
      ? String(parsed.posHint).trim() || undefined
      : undefined,
    def,
    chn,
    examples,
    collocations: asStringArray(parsed.collocations),
    synonyms: asStringArray(parsed.synonyms),
    notes: parsed.notes ? String(parsed.notes).trim() || undefined : undefined,
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
  const phrase = String(body.phrase ?? "").trim();
  // Basic sanity: 2..80 chars, must contain at least one letter.
  if (phrase.length < 2 || phrase.length > 80 || !/[a-zA-Z]/.test(phrase)) {
    return NextResponse.json({ error: "invalid phrase" }, { status: 400 });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return NextResponse.json(mockResult(phrase));
  }

  try {
    const result = await callDeepseek(phrase, apiKey);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[ai/phrase] deepseek call failed:", err);
    const fallback = mockResult(phrase);
    return NextResponse.json({ ...fallback, provider: "mock" });
  }
}
