/**
 * POST /api/ai/example
 *
 * Generates one English example sentence for a target lemma using the
 * Zhipu chain client (glm-4.5-air → glm-4.7-flash → glm-4-flash-250414).
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
 * Response body (success):
 *   {
 *     en: string, cn: string, highlights: string[],
 *     model: string, usage: { input, output, total },
 *   }
 *
 * Response body (all tiers failed) — HTTP 502:
 *   { error: "AI 调用失败", attempts: Array<{model, reason}> }
 */

import { NextResponse } from "next/server";
import {
  ZhipuFallbackError,
  callZhipuChain,
  extractJsonObject,
  type ZhipuUsage,
} from "@/lib/ai/zhipu";

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
  model: string;
  usage: ZhipuUsage;
}

function buildPrompt(
  lemma: string,
  sense?: SenseHint,
  known: string[] = [],
  avoid: string[] = [],
) {
  const senseLine = sense?.def
    ? `Use it in this sense: "${sense.def}"${sense.chn ? ` (中文: ${sense.chn})` : ""}.`
    : "Use the most common sense.";
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

  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "AI 调用失败",
        attempts: [{ model: "config", reason: "ZHIPU_API_KEY 未配置" }],
      },
      { status: 502 },
    );
  }

  // Diversity knobs: "再生成" needs a meaningfully different draft. The
  // avoid-list in the prompt is the primary defense; these sampling knobs
  // are belt-and-suspenders.
  const hasAvoid = avoid.length > 0;

  try {
    const call = await callZhipuChain(
      {
        prompt: buildPrompt(lemma, sense, known, avoid),
        temperature: hasAvoid ? 0.95 : 0.85,
        maxTokens: 240,
        extra: {
          top_p: 0.95,
          presence_penalty: hasAvoid ? 0.6 : 0.2,
          frequency_penalty: hasAvoid ? 0.5 : 0.1,
        },
      },
      apiKey,
      "ai/example",
      `word="${lemma}"`,
    );
    const jsonStr = extractJsonObject(call.content);
    if (!jsonStr) {
      throw new Error(
        `zhipu returned non-JSON: ${call.content.slice(0, 200)}`,
      );
    }
    const parsed = JSON.parse(jsonStr) as Partial<
      Pick<ResponseBody, "en" | "cn" | "highlights">
    >;
    const en = String(parsed.en ?? "").trim();
    const cn = String(parsed.cn ?? "").trim();
    if (!en) throw new Error("zhipu returned empty `en`");
    const hl = Array.isArray(parsed.highlights) ? parsed.highlights : [];
    const lemmasOnly = hl
      .map((s) => String(s).toLowerCase())
      .filter((s) => /^[a-z][a-z\-']*$/.test(s));
    const highlights = Array.from(new Set([lemma, ...lemmasOnly]));
    const resp: ResponseBody = {
      en,
      cn,
      highlights,
      model: call.model,
      usage: call.usage,
    };
    return NextResponse.json(resp);
  } catch (err) {
    if (err instanceof ZhipuFallbackError) {
      return NextResponse.json(
        { error: "AI 调用失败", attempts: err.attempts },
        { status: 502 },
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error("[ai/example] post-call error:", msg);
    return NextResponse.json(
      {
        error: "AI 调用失败",
        attempts: [{ model: "parse", reason: "模型返回内容无法解析" }],
      },
      { status: 502 },
    );
  }
}
