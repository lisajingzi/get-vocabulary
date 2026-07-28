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
 * Response body (success):
 *   {
 *     senses: Array<{ def: string; example: { en: string; cn: string } }>,
 *     model: "glm-4.5-air" | "glm-4.7-flash" | "glm-4-flash-250414",
 *     usage: { input: number; output: number; total: number },
 *   }
 *
 * Response body (all tiers failed) — HTTP 502:
 *   {
 *     error:    "AI 调用失败",
 *     attempts: Array<{ model: string; reason: string }>,
 *   }
 *
 * No mock fallback: if every tier of the chain fails we surface the
 * per-tier reason so the UI can display exactly why (see
 * `src/lib/ai/zhipu.ts` for the fallback chain + error translation).
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
  lemma: string;
}

interface DefinitionSense {
  def: string;
  example: { en: string; cn: string };
}

interface ResponseBody {
  senses: DefinitionSense[];
  model: string;
  usage: ZhipuUsage;
}

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
        prompt: buildPrompt(lemma),
        temperature: 0.3,
        maxTokens: 480,
      },
      apiKey,
      "ai/definition",
      `word="${lemma}"`,
    );
    const jsonStr = extractJsonObject(call.content);
    if (!jsonStr) {
      throw new Error(
        `zhipu returned non-JSON: ${call.content.slice(0, 200)}`,
      );
    }
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
    if (senses.length === 0) {
      throw new Error("zhipu returned no usable senses");
    }
    const resp: ResponseBody = {
      senses,
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
    // JSON parse / schema errors — treat as "the model responded but with
    // garbage". Surface a synthetic single-tier failure so the UI can show
    // something meaningful.
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error("[ai/definition] post-call error:", msg);
    return NextResponse.json(
      {
        error: "AI 调用失败",
        attempts: [{ model: "parse", reason: "模型返回内容无法解析" }],
      },
      { status: 502 },
    );
  }
}
