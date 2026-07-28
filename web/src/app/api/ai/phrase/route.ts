/**
 * POST /api/ai/phrase
 *
 * Ask the Zhipu chain (glm-4.5-air → glm-4.7-flash → glm-4-flash-250414)
 * to generate a rich dictionary-like explanation for an English phrase /
 * idiom (e.g. "take advantage of", "by the way"). Called ONCE per phrase
 * from /notebook/phrase/[slug]; the caller caches the result on the
 * notebook entry and never re-hits this endpoint for the same phrase.
 *
 * Request body:
 *   { phrase: "take advantage of" }
 *
 * Response body (success):
 *   {
 *     posHint?:      "verb phrase" | "prep phrase" | "idiom" | ...
 *     def:            string,
 *     chn:            string,
 *     examples:       Array<{ en: string; cn: string }>,
 *     collocations?:  string[],
 *     synonyms?:      string[],
 *     notes?:         string,
 *     model:          string,
 *     usage:          { input: number; output: number; total: number },
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
  model: string;
  usage: ZhipuUsage;
}

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

export async function POST(req: Request): Promise<Response> {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const phrase = String(body.phrase ?? "").trim();
  if (phrase.length < 2 || phrase.length > 80 || !/[a-zA-Z]/.test(phrase)) {
    return NextResponse.json({ error: "invalid phrase" }, { status: 400 });
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
        prompt: buildPrompt(phrase),
        temperature: 0.4,
        maxTokens: 900,
      },
      apiKey,
      "ai/phrase",
      `phrase="${phrase}"`,
    );
    const jsonStr = extractJsonObject(call.content);
    if (!jsonStr) {
      throw new Error(
        `zhipu returned non-JSON: ${call.content.slice(0, 200)}`,
      );
    }
    const parsed = JSON.parse(jsonStr) as Partial<ResponseBody> & {
      examples?: Array<{ en?: unknown; cn?: unknown }>;
      collocations?: unknown[];
      synonyms?: unknown[];
    };
    const def = String(parsed.def ?? "").trim();
    const chn = String(parsed.chn ?? "").trim();
    if (!def || !chn) throw new Error("zhipu returned incomplete payload");
    const rawExamples = Array.isArray(parsed.examples) ? parsed.examples : [];
    const examples = rawExamples
      .map((ex) => ({
        en: String(ex?.en ?? "").trim(),
        cn: String(ex?.cn ?? "").trim(),
      }))
      .filter((ex) => ex.en.length > 0)
      .slice(0, 5);
    if (examples.length === 0) {
      throw new Error("zhipu returned no examples");
    }
    const asStringArray = (v: unknown): string[] | undefined => {
      if (!Array.isArray(v)) return undefined;
      const cleaned = v
        .map((x) => String(x ?? "").trim())
        .filter((x) => x.length > 0)
        .slice(0, 8);
      return cleaned.length > 0 ? cleaned : undefined;
    };
    const resp: ResponseBody = {
      posHint: parsed.posHint
        ? String(parsed.posHint).trim() || undefined
        : undefined,
      def,
      chn,
      examples,
      collocations: asStringArray(parsed.collocations),
      synonyms: asStringArray(parsed.synonyms),
      notes: parsed.notes
        ? String(parsed.notes).trim() || undefined
        : undefined,
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
    console.error("[ai/phrase] post-call error:", msg);
    return NextResponse.json(
      {
        error: "AI 调用失败",
        attempts: [{ model: "parse", reason: "模型返回内容无法解析" }],
      },
      { status: 502 },
    );
  }
}
