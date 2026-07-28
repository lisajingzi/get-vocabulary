/**
 * POST /api/ai/correct
 *
 * IELTS/PTE-examiner-style English sentence feedback for a Chinese B2
 * learner. See the "two-track" design in the previous version of this
 * file — the prompt and normalisation logic are unchanged; only the
 * transport layer has moved to the shared Zhipu chain client.
 *
 * Response body (success):
 *   {
 *     ok: boolean,
 *     recommended: string,
 *     recommendedAlt?: string,
 *     segments: Array<{ text; wrong?; fix? }>,
 *     diagnosis: string[],
 *     suggestions?: Array<{ text; reason }>,
 *     distinction?: string,
 *     ielts?: string,
 *     model: string,
 *     usage: { input; output; total },
 *   }
 *
 * Response body (all tiers failed) — HTTP 502:
 *   { error: "AI 调用失败", attempts: Array<{model, reason}> }
 *
 * No mock fallback: on total failure we surface the per-tier reasons so
 * the UI can display them directly.
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
  sentence: string;
}

interface Segment {
  text: string;
  wrong?: boolean;
  fix?: string;
}

interface Suggestion {
  text: string;
  reason: string;
}

interface ResponseBody {
  ok: boolean;
  recommended: string;
  recommendedAlt?: string;
  segments: Segment[];
  diagnosis: string[];
  suggestions?: Suggestion[];
  distinction?: string;
  ielts?: string;
  model: string;
  usage: ZhipuUsage;
}

function buildPrompt(lemma: string, sentence: string, sense?: SenseHint) {
  const senseLine = sense?.def
    ? `Target sense: "${sense.def}"${sense.chn ? ` (中文: ${sense.chn})` : ""}.`
    : "Target sense: most common.";
  return [
    "You are an IELTS Writing examiner grading ONE English sentence",
    "from a Chinese B2 learner practising a specific target word.",
    "",
    `Target word: "${lemma}". ${senseLine}`,
    `Learner's sentence: """${sentence}"""`,
    "",
    "════════════════════════════════════════════════════════════════",
    "CORE RULES — apply in order.",
    "════════════════════════════════════════════════════════════════",
    `R1 (HIGHEST) \`recommended\` MUST contain "${lemma}" or its`,
    "   inflection (plural, past tense, gerund, etc.). NEVER replace",
    "   the target word with another word, even one that seems to fit",
    `   better. If the learner used "${lemma}" with a wrong meaning,`,
    `   keep "${lemma}" and rewrite the rest so it is used correctly;`,
    "   explain the confusion in `diagnosis`. Breaking R1 makes the",
    "   whole response INVALID.",
    "",
    "R2 Only flag an error when you can name a specific rule of",
    "   English: grammar (tense, agreement, countability, participle",
    "   form…), lexical incompatibility (wrong POS, wrong argument",
    "   structure, dictionary-flagged collocation), or spelling.",
    '   "Sounds unnatural" / "a native would prefer" is NOT an error.',
    "   If in doubt → not an error; put the alternative in",
    "   `suggestions` instead.",
    "",
    "R3 Every `diagnosis` line MUST cite the rule name in backticks",
    "   (in English). No rule name → drop the flag.",
    "",
    "R4 `suggestions`: at most 2, style upgrades only. OMIT the field",
    "   entirely if you have no genuinely better native phrasing.",
    "",
    "R5 `segments` is an ordered diff over the original: concatenating",
    "   every `text` must reproduce the learner's sentence verbatim.",
    "   `ok=true` ⇔ one plain segment, no `wrong` flag, `diagnosis=[]`.",
    "",
    "R6 Be concise. No markdown, no bullets, one sentence per",
    "   diagnosis / reason line. Chinese for `diagnosis` and",
    "   `suggestions[].reason`; English for everything else.",
    "",
    "════════════════════════════════════════════════════════════════",
    "OUTPUT — reply with ONLY this JSON object, no markdown:",
    "════════════════════════════════════════════════════════════════",
    "{",
    '  "ok": true|false,',
    `  "recommended": "<one English sentence, MUST contain ${lemma}>",`,
    '  "recommendedAlt": "<optional English sentence>",',
    '  "segments": [{"text":"..."}, {"text":"...","wrong":true,"fix":"..."}],',
    '  "diagnosis": ["<中文一句，含 `rule name` in backticks>"],',
    '  "suggestions": [{"text":"<English>","reason":"<中文>"}],',
    '  "distinction": "<optional 中文一句>",',
    `  "ielts": "<optional English sentence with ${lemma}>"`,
    "}",
    "",
    "Before returning, verify:",
    `(1) \`recommended\` contains "${lemma}" or its inflection — if not,`,
    "    rewrite it. This is R1.",
    "(2) Every `wrong` segment has a named rule in `diagnosis`.",
    "(3) `ok` matches `segments` and `diagnosis`.",
  ].join("\n");
}

/** Sanitise the model's JSON into a strict ResponseBody core. */
function normaliseResponse(
  parsed: unknown,
  sentence: string,
): Omit<ResponseBody, "model" | "usage"> {
  const p = (parsed ?? {}) as Record<string, unknown>;
  let ok = Boolean(p.ok);
  const recommended =
    typeof p.recommended === "string" && p.recommended.trim()
      ? p.recommended.trim()
      : sentence;
  const recommendedAlt =
    typeof p.recommendedAlt === "string" && p.recommendedAlt.trim()
      ? p.recommendedAlt.trim()
      : undefined;
  const segments: Segment[] = Array.isArray(p.segments)
    ? (p.segments as unknown[])
        .map((s) => {
          const seg = (s ?? {}) as Record<string, unknown>;
          return {
            text: String(seg.text ?? ""),
            wrong: Boolean(seg.wrong),
            fix: seg.fix !== undefined ? String(seg.fix) : undefined,
          };
        })
        .filter((s) => s.text.length > 0)
    : [{ text: sentence }];

  const diagnosisRaw: string[] = Array.isArray(p.diagnosis)
    ? (p.diagnosis as unknown[])
        .map((x) => String(x ?? "").trim())
        .filter((x) => x.length > 0)
    : [];

  // Rule-citation guardrail: if ok=false but no diagnosis line actually
  // cites a rule in backticks, treat as failed S1 → downgrade to ok=true.
  const hasCitedRule = diagnosisRaw.some((d) => /`[^`]+`/.test(d));
  if (!ok && !hasCitedRule) {
    ok = true;
  }
  if (ok) {
    for (const s of segments) {
      s.wrong = false;
      s.fix = undefined;
    }
  }
  const diagnosis: string[] = ok ? [] : diagnosisRaw.slice(0, 4);

  const suggestions: Suggestion[] | undefined = Array.isArray(p.suggestions)
    ? ((p.suggestions as unknown[])
        .map((s) => {
          const sg = (s ?? {}) as Record<string, unknown>;
          const text = String(sg.text ?? "").trim();
          const reason = String(sg.reason ?? "").trim();
          if (!text || !reason) return null;
          return { text, reason } as Suggestion;
        })
        .filter((s): s is Suggestion => s !== null)
        .slice(0, 2)) || undefined
    : undefined;
  const suggestionsClean =
    suggestions && suggestions.length > 0 ? suggestions : undefined;

  const distinction =
    typeof p.distinction === "string" && p.distinction.trim()
      ? p.distinction.trim()
      : undefined;
  const ielts =
    typeof p.ielts === "string" && p.ielts.trim()
      ? p.ielts.trim()
      : undefined;
  return {
    ok,
    recommended,
    recommendedAlt,
    segments,
    diagnosis,
    suggestions: suggestionsClean,
    distinction,
    ielts,
  };
}

export async function POST(req: Request): Promise<Response> {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const lemma = String(body.lemma ?? "").trim().toLowerCase();
  const sentence = String(body.sentence ?? "").trim();
  if (!lemma || !/^[a-z][a-z\-'\s]{0,40}$/.test(lemma)) {
    return NextResponse.json({ error: "invalid lemma" }, { status: 400 });
  }
  if (!sentence) {
    return NextResponse.json({ error: "empty sentence" }, { status: 400 });
  }

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

  try {
    const call = await callZhipuChain(
      {
        prompt: buildPrompt(lemma, sentence, body.sense),
        temperature: 0.2,
        maxTokens: 600,
      },
      apiKey,
      "ai/correct",
      `word="${lemma}"`,
    );
    const jsonStr = extractJsonObject(call.content);
    if (!jsonStr) {
      throw new Error(
        `zhipu returned non-JSON: ${call.content.slice(0, 200)}`,
      );
    }
    const parsed = JSON.parse(jsonStr) as unknown;
    const core = normaliseResponse(parsed, sentence);
    const resp: ResponseBody = {
      ...core,
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
    console.error("[ai/correct] post-call error:", msg);
    return NextResponse.json(
      {
        error: "AI 调用失败",
        attempts: [{ model: "parse", reason: "模型返回内容无法解析" }],
      },
      { status: 502 },
    );
  }
}
