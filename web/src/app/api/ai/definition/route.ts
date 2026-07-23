/**
 * POST /api/ai/definition
 *
 * Given a target English lemma, returns its 1–2 most common English
 * definitions, each paired with ONE example sentence (English + faithful
 * Chinese translation). Used by the "释义" button on each wordbook row: a
 * quick popup that lets the user recall/verify a word without leaving the
 * wordbook list, and lets them tap-to-hear the example.
 *
 * Product decision — English definitions ONLY (no Chinese gloss on the
 * definition itself). Chinese only shows up under the example so the user
 * still has a semantic anchor for the sentence.
 *
 * Request body:
 *   { lemma: "abandon" }
 *
 * Response body:
 *   {
 *     senses: Array<{ def: string; example: { en: string; cn: string } }>,
 *     provider: "deepseek" | "mock",
 *   }
 *
 * Fallback: if DEEPSEEK_API_KEY is missing OR the call fails, we return a
 * deterministic mock so the UI stays exercisable. Same pattern as the
 * other /api/ai/* routes in this project.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";

interface RequestBody {
  lemma: string;
}

interface DefinitionSense {
  def: string;
  example: { en: string; cn: string };
}

interface ResponseBody {
  senses: DefinitionSense[];
  provider: "deepseek" | "mock";
}

/** Match /api/ai/correct's URL resolution logic. */
function resolveChatUrl(): string {
  const raw = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(raw)) return raw;
  if (/\/v\d+$/.test(raw)) return `${raw}/chat/completions`;
  return `${raw}/v1/chat/completions`;
}
const CHAT_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

function buildPrompt(lemma: string): string {
  return [
    "You are an English lexicographer writing for a Chinese learner at CEFR B2.",
    `Target word: "${lemma}".`,
    "Task: give the 1 or 2 MOST COMMON senses of the word, each with a natural",
    "example sentence.",
    "Hard rules:",
    "- Output 1 sense if the word is essentially monosemous, otherwise 2 senses.",
    "  Never more than 2. Never 0.",
    "- Each `def` is a concise English definition, 6–18 words, in learner-",
    "  dictionary style (like Longman / Oxford Learner's). Do NOT include a",
    "  Chinese translation on the definition line.",
    "- Each `example.en` is ONE natural sentence, 10–22 words, at CEFR B2. It",
    "  MUST contain the target word (any normal inflection: -s/-ed/-ing/-er/plural).",
    "- Each `example.cn` is a faithful, natural Chinese translation of `example.en`.",
    "- Prefer everyday, concrete scenarios over jargon. If the word has two",
    "  clearly distinct meanings (e.g. verb vs noun sense, or literal vs",
    "  figurative), pick one for each of the 2 slots.",
    "Reply with ONLY a JSON object, no markdown fences, no commentary:",
    '{ "senses": [ { "def": "<english definition>", "example": { "en": "<sentence>", "cn": "<中文翻译>" } } ] }',
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

function mockResult(lemma: string): ResponseBody {
  // Two templated senses so the UI can render the 2-item layout even without
  // a real API key. Deterministic so tests stay stable.
  return {
    senses: [
      {
        def: `the most common sense of "${lemma}" (mock definition).`,
        example: {
          en: `They decided to ${lemma} the project after only three weeks.`,
          cn: `仅仅三周后，他们就决定 ${lemma} 这个项目。`,
        },
      },
      {
        def: `a secondary sense or usage of "${lemma}" (mock).`,
        example: {
          en: `In everyday speech, people often ${lemma} things without much thought.`,
          cn: `在日常口语中，人们经常不假思索地 ${lemma}。`,
        },
      },
    ],
    provider: "mock",
  };
}

async function callDeepseek(
  lemma: string,
  apiKey: string,
): Promise<ResponseBody> {
  const prompt = buildPrompt(lemma);
  const res = await fetch(resolveChatUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: prompt }],
      // Definitions should be stable — low temperature, no penalties.
      temperature: 0.3,
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
  if (!jsonStr) throw new Error(`deepseek returned non-JSON: ${content.slice(0, 200)}`);
  const parsed = JSON.parse(jsonStr) as {
    senses?: Array<{ def?: unknown; example?: { en?: unknown; cn?: unknown } }>;
  };
  const rawSenses = Array.isArray(parsed.senses) ? parsed.senses : [];
  const senses: DefinitionSense[] = rawSenses
    .map((s) => {
      const def = String(s?.def ?? "").trim();
      const en = String(s?.example?.en ?? "").trim();
      const cn = String(s?.example?.cn ?? "").trim();
      return { def, example: { en, cn } };
    })
    .filter((s) => s.def.length > 0 && s.example.en.length > 0)
    .slice(0, 2);
  if (senses.length === 0) throw new Error("deepseek returned no usable senses");
  return { senses, provider: "deepseek" };
}

export async function POST(req: Request): Promise<Response> {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const lemma = String(body.lemma ?? "").trim().toLowerCase();
  if (!lemma || !/^[a-z][a-z\-'\s]{0,40}$/.test(lemma)) {
    return NextResponse.json({ error: "invalid lemma" }, { status: 400 });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return NextResponse.json(mockResult(lemma));
  }

  try {
    const result = await callDeepseek(lemma, apiKey);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[ai/definition] deepseek call failed:", err);
    const fallback = mockResult(lemma);
    return NextResponse.json({ ...fallback, provider: "mock" });
  }
}
