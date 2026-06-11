/**
 * POST /api/ai/example
 *
 * Generates one English example sentence for a target lemma, using DeepSeek
 * if a key is configured and otherwise a deterministic mock so the rest of
 * the UI is testable end-to-end.
 *
 * Request body:
 *   {
 *     lemma:   "abandon",
 *     sense?:  { def?: string; chn?: string; pos?: string },
 *     known?:  string[]   // up to ~50 lemmas the user has already looked up;
 *                          // we ask the model to weave 1–3 of them into the
 *                          // sentence so the user gets cross-word reinforcement.
 *   }
 *
 * Response body:
 *   { en: string, cn: string, highlights: string[], provider: "deepseek" | "mock" }
 *
 * Day 7 will swap the runtime to read DEEPSEEK_API_KEY from a real Vercel env.
 * Until then the route works either way: the user gets a mock today, the same
 * shape ships when the real key lands, the UI doesn't change.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";

interface SenseHint {
  def?: string;
  chn?: string;
  pos?: string;
}

interface RequestBody {
  lemma: string;
  sense?: SenseHint;
  known?: string[];
}

interface ResponseBody {
  en: string;
  cn: string;
  /** Lowercase lemmas that should be visually highlighted in `en`. Always
   *  contains `lemma` itself plus any of `known` we successfully wove in. */
  highlights: string[];
  provider: "deepseek" | "mock";
}

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

function buildPrompt(lemma: string, sense?: SenseHint, known: string[] = []) {
  const senseLine = sense?.def
    ? `Use it in this sense: "${sense.def}"${sense.chn ? ` (中文: ${sense.chn})` : ""}.`
    : "Use the most common sense.";
  const woven = known.slice(0, 30);
  const knownLine =
    woven.length > 0
      ? `Try to naturally weave 1 to 3 of these words the learner already knows into the sentence: ${woven.join(", ")}.`
      : "";
  return [
    "You are a CEFR B2-level English example-sentence generator for a Chinese learner.",
    `Target word: "${lemma}". ${senseLine}`,
    knownLine,
    "Constraints:",
    "- One sentence only, 12–24 words, natural and idiomatic.",
    "- Do NOT inflect the target word beyond what's grammatical (-s/-ed/-ing OK).",
    "- The Chinese translation must be a faithful, fluent rendering.",
    "Reply with ONLY a JSON object, no markdown fences:",
    '{ "en": "<sentence>", "cn": "<中文翻译>", "highlights": ["word1", "word2"] }',
    "highlights must be lowercase lemmas actually present in `en` (including the target).",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Pull the first balanced JSON object out of arbitrary model output. We
 *  ask for raw JSON, but models sometimes wrap it in fences anyway. */
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
  lemma: string,
  sense?: SenseHint,
  known: string[] = [],
): ResponseBody {
  // Pick up to 2 known words to splice into a templated sentence so the
  // mock visually exercises the highlight code path.
  const woven = known
    .filter((w) => w !== lemma && /^[a-z]+$/.test(w))
    .slice(0, 2);
  let en: string;
  let cn: string;
  if (woven.length === 2) {
    en = `She decided to ${lemma} the ${woven[0]} after a long ${woven[1]}.`;
    cn = `经过漫长的"${woven[1]}"之后，她决定 ${lemma} 那个"${woven[0]}"。`;
  } else if (woven.length === 1) {
    en = `He had to ${lemma} his ${woven[0]} when the storm arrived.`;
    cn = `暴风雨来临时，他不得不 ${lemma} 他的"${woven[0]}"。`;
  } else {
    en = `They were forced to ${lemma} the project after only three weeks.`;
    cn = `仅仅三周后，他们就被迫 ${lemma} 这个项目。`;
  }
  const highlights = Array.from(new Set([lemma, ...woven]));
  return { en, cn, highlights, provider: "mock" };
}

async function callDeepseek(
  lemma: string,
  sense: SenseHint | undefined,
  known: string[],
  apiKey: string,
): Promise<ResponseBody> {
  const prompt = buildPrompt(lemma, sense, known);
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.8,
      max_tokens: 240,
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
  const parsed = JSON.parse(jsonStr) as Partial<ResponseBody>;
  const en = String(parsed.en ?? "").trim();
  const cn = String(parsed.cn ?? "").trim();
  if (!en) throw new Error("deepseek returned empty `en`");
  // Ensure target lemma always shows up in highlights, regardless of whether
  // the model echoed it back. The UI does case-insensitive whole-word match
  // so we don't need to track the exact inflected form here.
  const hl = Array.isArray(parsed.highlights) ? parsed.highlights : [];
  const lemmasOnly = hl
    .map((s) => String(s).toLowerCase())
    .filter((s) => /^[a-z][a-z\-']*$/.test(s));
  const highlights = Array.from(new Set([lemma, ...lemmasOnly]));
  return { en, cn, highlights, provider: "deepseek" };
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
  const sense = body.sense;
  const known = Array.isArray(body.known)
    ? body.known
        .filter((s) => typeof s === "string")
        .map((s) => s.toLowerCase())
        .slice(0, 50)
    : [];

  const apiKey = process.env.DEEPSEEK_API_KEY;
  // No key configured → return a mock so devs/users can still iterate UI.
  if (!apiKey) {
    return NextResponse.json(mockResult(lemma, sense, known));
  }

  try {
    const result = await callDeepseek(lemma, sense, known, apiKey);
    return NextResponse.json(result);
  } catch (err) {
    // Don't 500 — degrade gracefully so the UI keeps working. Surface the
    // provider downgrade so the client can show a small notice.
    console.error("[ai/example] deepseek call failed:", err);
    const fallback = mockResult(lemma, sense, known);
    return NextResponse.json({ ...fallback, provider: "mock" });
  }
}
