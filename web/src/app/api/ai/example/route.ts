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
 *                          // we ask the model to weave exactly 1 of them into
 *                          // the sentence so the user gets cross-word reinforcement.
 *     avoid?:  string[]   // recently generated English sentences for THIS
 *                          // (lemma, sense). Sent on "再生成" so the model
 *                          // doesn't echo them back nearly verbatim.
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
  /** Recent English sentences for the same (lemma, sense) — the model
   *  is told to produce something materially different. */
  avoid?: string[];
}

interface ResponseBody {
  en: string;
  cn: string;
  /** Lowercase lemmas that should be visually highlighted in `en`. Always
   *  contains `lemma` itself plus any of `known` we successfully wove in. */
  highlights: string[];
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
  lemma: string,
  sense?: SenseHint,
  known: string[] = [],
  avoid: string[] = [],
) {
  const senseLine = sense?.def
    ? `Use it in this sense: "${sense.def}"${sense.chn ? ` (中文: ${sense.chn})` : ""}.`
    : "Use the most common sense.";
  // Cap the pool the model sees. Too many candidates pushes the model to
  // jam several in just to "use the list", which is exactly what produces
  // the "high entropy and sudden emotional arousal" type of garbage.
  const woven = known.slice(0, 20);
  const knownLine =
    woven.length > 0
      ? [
          `Vocabulary pool (words the learner already studied): ${woven.join(", ")}.`,
          "REQUIREMENT: pick exactly ONE word from this pool that fits a",
          "natural everyday sentence with the target word, and use it. Pick",
          "the pool word FIRST by asking yourself \"which of these words",
          "co-occurs naturally with the target in real English?\" — then",
          "build the sentence around that pairing. If genuinely none of",
          "the pool words can co-occur with the target without sounding",
          "forced (rare), you may skip the pool, but you must still write",
          "a natural sentence. NEVER use 2 or more pool words in the same",
          "sentence. Naturalness always wins over coverage.",
        ].join(" ")
      : "";
  const avoidLine =
    avoid.length > 0
      ? [
          "You have already produced these sentences for this same word; the",
          "learner just clicked \"再生成\" because they want a DIFFERENT one.",
          "Your new sentence must use a clearly different scenario, subject,",
          "and main verb — not just swap one or two words. If your draft",
          "shares more than ~40% of its content words with any previous one,",
          "discard it and try a completely different angle (different setting,",
          "different speaker, different pool word, etc.).",
          `Previously produced (avoid echoing):`,
          ...avoid.slice(0, 5).map((s, i) => `  ${i + 1}. ${s}`),
        ].join("\n")
      : "";
  return [
    "You are an English example-sentence writer for a Chinese learner at CEFR B2.",
    `Target word: "${lemma}". ${senseLine}`,
    knownLine,
    avoidLine,
    "Hard rules — read carefully:",
    "- Output exactly ONE sentence, 10–22 words, that a native speaker would",
    "  plausibly say or write in everyday life, journalism, or fiction.",
    "- The sentence MUST make sense on its own and describe a believable",
    "  situation. Prefer concrete, ordinary scenarios (daily life, work,",
    "  study, news, simple stories) over abstract or technical jargon.",
    "- Showcase how the target word is normally used. Common collocations",
    "  and natural phrasing are the goal.",
    "- Do NOT chain together unrelated advanced vocabulary just to sound",
    '  sophisticated. Bad example: "His unique interpretation of the chaos',
    '  focuses on the link between high entropy and sudden emotional',
    '  arousal." — this is incoherent and forbidden.',
    "- Good example for target=arousal (with pool word \"fear\" woven in):",
    '  "The loud bang in the alley caused a sudden arousal of fear among',
    '   the late-night shoppers."',
    "- Do not inflect the target word beyond normal grammar (-s/-ed/-ing/-er/-est/plural).",
    "- The Chinese translation must be faithful and read naturally in Chinese.",
    "Reply with ONLY a JSON object, no markdown fences, no commentary:",
    '{ "en": "<sentence>", "cn": "<中文翻译>", "highlights": ["word1", "word2"] }',
    "highlights = lowercase lemmas actually present in `en`, including the target",
    "and the ONE pool word you wove in (if any).",
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
  avoid: string[],
  apiKey: string,
): Promise<ResponseBody> {
  const prompt = buildPrompt(lemma, sense, known, avoid);
  // Diversity knobs — "再生成" must produce a meaningfully different draft.
  // We bumped temperature back up (0.6 was too tame, every retry came out
  // as a near-duplicate of the first sentence) and added presence/frequency
  // penalties so the model is actively pushed off whatever phrasing it just
  // produced. The avoid-list in the prompt is the primary defense; these
  // sampling knobs are belt-and-suspenders.
  const hasAvoid = avoid.length > 0;
  const res = await fetch(resolveChatUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: hasAvoid ? 0.95 : 0.85,
      top_p: 0.95,
      presence_penalty: hasAvoid ? 0.6 : 0.2,
      frequency_penalty: hasAvoid ? 0.5 : 0.1,
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
  const avoid = Array.isArray(body.avoid)
    ? body.avoid
        .filter((s) => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim())
        .slice(0, 5)
    : [];

  const apiKey = process.env.DEEPSEEK_API_KEY;
  // No key configured → return a mock so devs/users can still iterate UI.
  if (!apiKey) {
    return NextResponse.json(mockResult(lemma, sense, known));
  }

  try {
    const result = await callDeepseek(lemma, sense, known, avoid, apiKey);
    return NextResponse.json(result);
  } catch (err) {
    // Don't 500 — degrade gracefully so the UI keeps working. Surface the
    // provider downgrade so the client can show a small notice.
    console.error("[ai/example] deepseek call failed:", err);
    const fallback = mockResult(lemma, sense, known);
    return NextResponse.json({ ...fallback, provider: "mock" });
  }
}
