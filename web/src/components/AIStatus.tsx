"use client";

/**
 * Shared UI helpers for AI-backed panels.
 *
 * Every /api/ai/* route returns one of two shapes:
 *
 *   success  → { ...data, model: "glm-4.5-air", usage: { input, output, total } }
 *   failure  → HTTP 502 with { error: "AI 调用失败", attempts: [{model, reason}] }
 *
 * The components exported from this file render each shape in a consistent
 * way across DerivedFormPanel, AIExamplesPanel, phrase/[slug]/page and
 * ReviewView. Keeping the presentation in one place means we can tune it
 * once (labels, colours, tooltip copy) without hunting through 4 different
 * call sites.
 */

import React from "react";

/** One tier's failure reason, mirrors the API `attempts` array. */
export interface AIAttempt {
  /** Model id, e.g. "glm-4.5-air", or a synthetic slot like "config"/"parse". */
  model: string;
  /** Human-readable Chinese reason produced by the server. */
  reason: string;
}

const MODEL_LABEL: Record<string, string> = {
  "glm-4.5-air": "GLM-4.5-Air",
  "glm-4.7-flash": "GLM-4.7-Flash",
  "glm-4-flash-250414": "GLM-4-Flash-老版",
  config: "配置",
  parse: "内容解析",
};

function labelForModel(m: string): string {
  return MODEL_LABEL[m] ?? m;
}

interface AIErrorNoticeProps {
  attempts: AIAttempt[];
  /** Optional heading. Defaults to "AI 调用失败". */
  title?: string;
  /** Optional extra advice line (e.g. "下方仍是原始词条"). */
  hint?: string;
  className?: string;
}

/**
 * Red inline error card. Multi-tier failures render as a bullet list so it
 * is immediately visible which models were tried and why each one failed.
 * Single-tier failures collapse to a one-liner.
 */
export function AIErrorNotice({
  attempts,
  title = "AI 调用失败",
  hint,
  className = "",
}: AIErrorNoticeProps) {
  if (attempts.length === 0) return null;
  const single = attempts.length === 1;
  return (
    <div
      className={
        "rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 " +
        className
      }
      role="alert"
    >
      <p className="font-medium">❌ {title}</p>
      {single ? (
        <p className="mt-0.5">
          {labelForModel(attempts[0].model)}：{attempts[0].reason}
        </p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {attempts.map((a, i) => (
            <li key={i}>
              • {labelForModel(a.model)}：{a.reason}
            </li>
          ))}
        </ul>
      )}
      {hint && <p className="mt-1 text-red-600/80">{hint}</p>}
    </div>
  );
}

interface AIUsageNoteProps {
  model?: string;
  usage?: { input: number; output: number; total: number };
  className?: string;
}

/**
 * Grey inline "🔢 234 tokens · GLM-4.5-Air" footnote shown under a
 * successful AI result. Purely informational; hidden if usage is missing
 * (e.g. legacy cached rows generated before usage tracking landed).
 */
export function AIUsageNote({
  model,
  usage,
  className = "",
}: AIUsageNoteProps) {
  if (!usage || usage.total <= 0) return null;
  return (
    <p
      className={
        "text-[11px] leading-tight text-[var(--fg-soft)] " + className
      }
      title={`本次调用 · 输入 ${usage.input} + 输出 ${usage.output} = 共 ${usage.total} tokens${
        model ? ` · 模型 ${labelForModel(model)}` : ""
      }`}
    >
      🔢 {usage.total} tokens
      {" ("}
      输入 {usage.input} · 输出 {usage.output}
      {")"}
      {model && (
        <>
          {" · "}
          <span>{labelForModel(model)}</span>
        </>
      )}
    </p>
  );
}

/**
 * Parse an /api/ai/* error response into an AIAttempt[]. Meant for the
 * client-side `.catch` branch:
 *
 *   const res = await fetch(...);
 *   if (!res.ok) {
 *     const attempts = await parseAIErrorAttempts(res);
 *     setAttempts(attempts);
 *     return;
 *   }
 *
 * Falls back to a synthetic one-liner if the body isn't the expected shape
 * (e.g. a 500 from an unexpected crash somewhere upstream).
 */
export async function parseAIErrorAttempts(
  res: Response,
): Promise<AIAttempt[]> {
  try {
    const body = (await res.json()) as {
      attempts?: Array<{ model?: unknown; reason?: unknown }>;
    };
    if (Array.isArray(body.attempts) && body.attempts.length > 0) {
      return body.attempts.map((a) => ({
        model: String(a.model ?? "unknown"),
        reason: String(a.reason ?? "未知错误"),
      }));
    }
  } catch {
    /* not JSON — synthesise a fallback below */
  }
  return [
    {
      model: "network",
      reason: `请求失败（HTTP ${res.status}）`,
    },
  ];
}
