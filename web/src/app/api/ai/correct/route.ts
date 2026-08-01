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
  model: string;
  usage: ZhipuUsage;
}

function buildPrompt(lemma: string, sentence: string, sense?: SenseHint) {
  const senseLine = sense?.def
    ? `Target sense: "${sense.def}"${sense.chn ? ` (中文: ${sense.chn})` : ""}.`
    : "Target sense: most common.";
  return [
    "You are an IELTS examiner grading ONE English sentence from a",
    "Chinese B2 learner practising a target word.",
    "",
    `Target word: "${lemma}". ${senseLine}`,
    `Learner's sentence: """${sentence}"""`,
    "",
    "Rules:",
    `R1 (HIGHEST) \`recommended\` MUST contain "${lemma}" or an inflection`,
    "   (plural, past, gerund, etc.). NEVER replace the target word,",
    "   even if another word seems to fit better. If the learner used",
    `   "${lemma}" with a wrong meaning, keep "${lemma}" and rewrite the`,
    "   rest so it is used correctly; explain in `diagnosis`. Breaking",
    "   R1 makes the response INVALID.",
    "R2 Flag an error only when you can name a specific rule of English",
    "   (grammar, lexical incompatibility, or spelling). \"Sounds",
    "   unnatural\" is NOT an error — put such alternatives in",
    "   `suggestions`.",
    "R3 Each `diagnosis` line MUST cite a rule name in backticks",
    "   (English). No rule name → drop the flag.",
    "R4 `suggestions`: ≤2 style upgrades. Omit the field if none.",
    "R5 `segments` = ordered diff; concatenating each `text` reproduces",
    "   the original. `ok=true` ⇔ one plain segment, `diagnosis=[]`.",
    "R6 Concise, no markdown. `diagnosis` and `suggestions[].reason` in",
    "   Chinese; everything else in English.",
    "",
    "Reply with ONLY this JSON:",
    "{",
    '  "ok": true|false,',
    '  "recommended": "<English, must include target word>",',
    '  "recommendedAlt": "<optional>",',
    '  "segments": [{"text":"..."}, {"text":"...","wrong":true,"fix":"..."}],',
    '  "diagnosis": ["<中文，含 `rule name`>"],',
    '  "suggestions": [{"text":"<English>","reason":"<中文>"}],',
    '  "distinction": "<optional 中文>"',
    "}",
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
  return {
    ok,
    recommended,
    recommendedAlt,
    segments,
    diagnosis,
    suggestions: suggestionsClean,
    distinction,
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
