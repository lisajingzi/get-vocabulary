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
 * Response body (success):
 *   {
 *     pos:      string,
 *     phonUk?:  string,
 *     phonUs?:  string,
 *     def:      string,
 *     chn:      string,
 *     examples: Array<{ en: string; cn: string }>,
 *     model:    string,
 *     usage:    { input: number; output: number; total: number },
 *   }
 *
 * Response body (all tiers failed) — HTTP 502:
 *   { error: "AI 调用失败", attempts: Array<{model, reason}> }
 *
 * No mock fallback: on total failure we surface the per-tier reasons so
 * the UI can display them directly. See `src/lib/ai/zhipu.ts` for the
 * fallback chain + error translation.
 */

import { NextResponse } from "next/server";
import {
  ZhipuFallbackError,
  callZhipuChain,
  extractJsonObject,
  type ZhipuUsage,
} from "@/lib/ai/zhipu";

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
  model: string;
  usage: ZhipuUsage;
}

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

export async function POST(req: Request): Promise<Response> {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const derived = String(body.derived ?? "").trim().toLowerCase();
  const base = String(body.base ?? "").trim().toLowerCase();
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

  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "AI 调用失败",
        attempts: [
          { model: "config", reason: "ZHIPU_API_KEY 未配置" },
        ],
      },
      { status: 502 },
    );
  }

  try {
    const call = await callZhipuChain(
      {
        prompt: buildPrompt(derived, base, body.baseSense),
        temperature: 0.4,
        maxTokens: 480,
      },
      apiKey,
      "ai/derived",
      `derived="${derived}", base="${base}"`,
    );
    const jsonStr = extractJsonObject(call.content);
    if (!jsonStr) {
      throw new Error(
        `zhipu returned non-JSON: ${call.content.slice(0, 200)}`,
      );
    }
    const parsed = JSON.parse(jsonStr) as Partial<ResponseBody> & {
      examples?: Array<{ en?: unknown; cn?: unknown }>;
    };
    const pos = String(parsed.pos ?? "").trim();
    const def = String(parsed.def ?? "").trim();
    const chn = String(parsed.chn ?? "").trim();
    if (!pos || !def) throw new Error("zhipu returned incomplete payload");
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
    const resp: ResponseBody = {
      pos,
      phonUk,
      phonUs,
      def,
      chn,
      examples,
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
    console.error("[ai/derived] post-call error:", msg);
    return NextResponse.json(
      {
        error: "AI 调用失败",
        attempts: [{ model: "parse", reason: "模型返回内容无法解析" }],
      },
      { status: 502 },
    );
  }
}
