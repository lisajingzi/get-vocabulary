/**
 * Shared Zhipu (智谱开放平台) chat client with three-tier fallback.
 *
 * All /api/ai/* routes share this call path so the fallback policy, error
 * translation and usage-logging stay consistent across the codebase.
 *
 * Tier order:
 *   1. glm-4.5-air              — paid model. Cheap, fast, high quality.
 *                                 Draws from a 12M-token free resource pack
 *                                 (3-month expiry); after that, billed per
 *                                 token. Because it's a paid pool it does
 *                                 not suffer the free-tier "1305 model
 *                                 overloaded" storms.
 *   2. glm-4.7-flash            — free model, current flagship free tier.
 *                                 Same overloaded pool everyone else uses.
 *   3. glm-4-flash-250414       — free model, older and less popular. Used
 *                                 as last-resort backup because its pool
 *                                 rarely saturates.
 *
 * Only 429 and 5xx trigger fallback to the next tier. 4xx (bad key,
 * insufficient balance, missing permission, invalid model, etc.) is
 * surfaced immediately for the current tier — but we still try lower tiers
 * because 402 on tier 1 (paid) is exactly when we WANT to fall through to
 * a free tier.
 *
 * Each tier retries once (1s later) on 429 before giving up on that tier.
 */

const ZHIPU_CHAT_URL =
  "https://open.bigmodel.cn/api/paas/v4/chat/completions";

/** Ordered from best/preferred to last-resort. */
export const ZHIPU_MODEL_CHAIN = [
  "glm-4.5-air",
  "glm-4.7-flash",
  "glm-4-flash-250414",
] as const;

export type ZhipuModel = (typeof ZHIPU_MODEL_CHAIN)[number];

/** Human-readable label shown in the UI when a call fails. */
export const ZHIPU_MODEL_LABEL: Record<ZhipuModel, string> = {
  "glm-4.5-air": "GLM-4.5-Air",
  "glm-4.7-flash": "GLM-4.7-Flash",
  "glm-4-flash-250414": "GLM-4-Flash-老版",
};

export interface ZhipuUsage {
  /** Prompt tokens (input). */
  input: number;
  /** Completion tokens (output). */
  output: number;
  /** Total tokens (input + output; usually the same as input+output). */
  total: number;
}

export interface ZhipuCallResult {
  /** Raw content string of the assistant message. */
  content: string;
  /** Which model actually produced this result. */
  model: ZhipuModel;
  /** Token usage reported by the API. Zero-filled if the API omitted it. */
  usage: ZhipuUsage;
  /** Wall-clock milliseconds spent on the (successful) call, incl. retries. */
  durationMs: number;
}

/** One failed attempt on the fallback chain. */
export interface ZhipuAttemptFailure {
  model: ZhipuModel;
  /** Human-friendly Chinese reason ("模型正忙", "账户余额不足", ...). */
  reason: string;
}

/**
 * Thrown from `callZhipuChain` when EVERY tier fails. Carries the per-tier
 * translated reasons so the API route can forward them to the UI as-is.
 */
export class ZhipuFallbackError extends Error {
  attempts: ZhipuAttemptFailure[];
  constructor(attempts: ZhipuAttemptFailure[]) {
    super(
      "AI 调用失败：" +
        attempts.map((a) => `${ZHIPU_MODEL_LABEL[a.model]}(${a.reason})`).join(" → "),
    );
    this.name = "ZhipuFallbackError";
    this.attempts = attempts;
  }
}

interface ChatPayload {
  /** Full prompt as a single user message. */
  prompt: string;
  /** Sampling temperature (default 0.4). */
  temperature?: number;
  /** Max output tokens for the model to generate. */
  maxTokens?: number;
  /** Extra fields merged into the request body (e.g. top_p, penalties). */
  extra?: Record<string, unknown>;
}

/**
 * Translate a Zhipu HTTP error into a short Chinese reason a user can act
 * on. Falls back to a generic label + status code when we don't recognise
 * the specific error.
 */
function translateZhipuError(status: number, bodyText: string): string {
  // Try to parse the JSON error envelope. Zhipu returns:
  //   { "error": { "code": "1305", "message": "..." } }
  let code: string | undefined;
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { code?: unknown; message?: unknown };
    };
    if (parsed.error?.code !== undefined) {
      code = String(parsed.error.code);
    }
  } catch {
    /* not JSON — fine, fall through to status-based mapping */
  }
  if (status === 429) {
    if (code === "1302") return "请求太频繁（账户限流）";
    if (code === "1305") return "模型正忙，请稍后再试";
    return "请求过多，请稍后再试";
  }
  if (status === 401) return "API Key 无效";
  if (status === 402) return "账户余额不足";
  if (status === 403) return "无权访问此模型";
  if (status === 404) return "模型不存在";
  if (status >= 500) return "智谱服务器出错";
  return `请求失败（HTTP ${status}）`;
}

async function callSingleModel(
  model: ZhipuModel,
  payload: ChatPayload,
  apiKey: string,
): Promise<{ content: string; usage: ZhipuUsage }> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: payload.prompt }],
    temperature: payload.temperature ?? 0.4,
    max_tokens: payload.maxTokens ?? 600,
    ...(payload.extra ?? {}),
  };
  // GLM-4.7-Flash & GLM-4.5-Air both default to "forced thinking" mode
  // which spends tokens on hidden reasoning we don't need for JSON tasks.
  // The `thinking` param is safely ignored by models that don't support it.
  body.thinking = { type: "disabled" };

  const res = await fetch(ZHIPU_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(text) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const usage: ZhipuUsage = {
    input: data.usage?.prompt_tokens ?? 0,
    output: data.usage?.completion_tokens ?? 0,
    total:
      data.usage?.total_tokens ??
      (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0),
  };
  return { content, usage };
}

/**
 * Try each model in the chain in order. Each tier retries once on 429 with
 * a 1s backoff. On any non-429 failure we record the reason and immediately
 * try the next tier — with one exception: 4xx that isn't 429 usually means
 * misconfiguration for the CURRENT model (e.g. 402 = out of quota on the
 * paid model), which is exactly the case where we DO want to fall through.
 * So we treat any error as "advance to next tier" and only actually give up
 * once the chain is exhausted.
 *
 * @param logTag  Short tag like "ai/correct" used in server logs.
 * @param wordTag Optional identifier (word / phrase) added to the log line.
 */
export async function callZhipuChain(
  payload: ChatPayload,
  apiKey: string,
  logTag: string,
  wordTag = "",
): Promise<ZhipuCallResult> {
  const started = Date.now();
  const failures: ZhipuAttemptFailure[] = [];
  for (const model of ZHIPU_MODEL_CHAIN) {
    // Per-tier: try once, retry once on 429 after 1s.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { content, usage } = await callSingleModel(
          model,
          payload,
          apiKey,
        );
        const durationMs = Date.now() - started;
        // eslint-disable-next-line no-console
        console.log(
          `[${logTag}] usage: input=${usage.input}, output=${usage.output}, ` +
            `total=${usage.total}  (model=${model}${
              wordTag ? `, ${wordTag}` : ""
            }, ${durationMs}ms)`,
        );
        return { content, model, usage, durationMs };
      } catch (err) {
        const status =
          (err as { status?: number } | undefined)?.status ?? 0;
        const bodyText = err instanceof Error ? err.message : String(err);
        const isRetryable429 = status === 429 && attempt === 0;
        if (isRetryable429) {
          // eslint-disable-next-line no-console
          console.warn(
            `[${logTag}] ${model} 429, retrying once after 1s...`,
          );
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        const reason = translateZhipuError(status, bodyText);
        failures.push({ model, reason });
        // eslint-disable-next-line no-console
        console.warn(
          `[${logTag}] ${model} failed (${reason}); ` +
            `falling back to next tier`,
        );
        break; // exit retry loop → outer `for` moves to next model
      }
    }
  }
  throw new ZhipuFallbackError(failures);
}

/**
 * Convenience: extract the first balanced JSON object from a raw model
 * output. Shared across all routes.
 */
export function extractJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
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
