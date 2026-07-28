"use client";

/**
 * <DefinitionModal /> — the popup behind the "释义" button on each wordbook row.
 *
 * Behaviour:
 *   - On open, tries the IndexedDB cache first. Cache hit → paint immediately,
 *     no usage footnote (no tokens were spent).
 *   - Cache miss → POST /api/ai/definition. On success we persist the payload
 *     and show a one-line "本次消耗 N tokens" footnote until the user closes
 *     the modal.
 *   - On complete failure (all three fallback tiers down), we DON'T mock —
 *     we display a red <AIErrorNotice> listing each tier that failed and why,
 *     translated into Chinese by the server.
 *   - Close options: click the ✕, click the backdrop, or press Esc.
 *   - "再生成" refetches and overwrites the cache.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import SpeakButton from "@/components/SpeakButton";
import {
  AIErrorNotice,
  AIUsageNote,
  parseAIErrorAttempts,
  type AIAttempt,
} from "@/components/AIStatus";
import {
  getCachedDefinition,
  saveDefinition,
  type AIDefinition,
  type DefinitionSense,
} from "@/lib/ai/definition-cache";

interface Props {
  /** Which lemma to show. `null` → modal is closed. */
  lemma: string | null;
  onClose: () => void;
}

interface ApiResponse {
  senses: DefinitionSense[];
  model: string;
  usage: { input: number; output: number; total: number };
}

/** Ephemeral, per-fetch usage snapshot. Never persisted. */
interface FreshUsage {
  model: string;
  usage: { input: number; output: number; total: number };
}

export default function DefinitionModal({ lemma, onClose }: Props) {
  const [data, setData] = useState<AIDefinition | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempts, setAttempts] = useState<AIAttempt[]>([]);
  const [fresh, setFresh] = useState<FreshUsage | null>(null);
  // Track the lemma we're currently loading so a late response from a
  // previous open doesn't overwrite a newer one (e.g. rapid switch A→B).
  const activeLemmaRef = useRef<string | null>(null);

  const fetchAndCache = useCallback(
    async (target: string, forceRefresh: boolean) => {
      activeLemmaRef.current = target;
      setBusy(true);
      setAttempts([]);
      setFresh(null);
      try {
        if (!forceRefresh) {
          const cached = await getCachedDefinition(target);
          if (cached && activeLemmaRef.current === target) {
            setData(cached);
            setBusy(false);
            return;
          }
        }
        const res = await fetch("/api/ai/definition", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lemma: target }),
        });
        if (!res.ok) {
          const parsed = await parseAIErrorAttempts(res);
          if (activeLemmaRef.current === target) {
            setAttempts(parsed);
          }
          return;
        }
        const payload = (await res.json()) as ApiResponse;
        if (!Array.isArray(payload.senses) || payload.senses.length === 0) {
          if (activeLemmaRef.current === target) {
            setAttempts([
              { model: "parse", reason: "模型返回内容无法解析" },
            ]);
          }
          return;
        }
        const saved = await saveDefinition(target, payload.senses);
        // Guard: if the user has since switched lemmas, discard this result.
        if (activeLemmaRef.current === target) {
          setData(saved);
          setFresh({ model: payload.model, usage: payload.usage });
        }
      } catch (e) {
        if (activeLemmaRef.current === target) {
          setAttempts([
            {
              model: "network",
              reason: (e as Error).message || "网络请求失败",
            },
          ]);
        }
      } finally {
        if (activeLemmaRef.current === target) {
          setBusy(false);
        }
      }
    },
    [],
  );

  // Reset + load whenever the target lemma changes.
  useEffect(() => {
    if (!lemma) {
      activeLemmaRef.current = null;
      setData(null);
      setAttempts([]);
      setFresh(null);
      setBusy(false);
      return;
    }
    setData(null);
    setAttempts([]);
    setFresh(null);
    void fetchAndCache(lemma, false);
  }, [lemma, fetchAndCache]);

  // Close on Esc while open. Also lock body scroll to avoid the wordbook
  // list scrolling behind the modal on mobile.
  useEffect(() => {
    if (!lemma) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [lemma, onClose]);

  if (!lemma) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`释义：${lemma}`}
      className="fixed inset-0 z-[100] flex items-center justify-center px-4"
    >
      {/* Backdrop — clicking it closes. */}
      <div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
      />

      {/* Card */}
      <div
        className="relative z-[1] w-full max-w-md rounded-[var(--radius-lg)] border border-white/80 bg-[var(--card)] shadow-[var(--shadow-md)] max-h-[85vh] overflow-hidden flex flex-col"
        // Stop clicks inside from bubbling to the backdrop.
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-[var(--border)]/60 px-5 py-3 shrink-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <h3 className="truncate text-[17px] font-semibold tracking-tight">
              {lemma}
            </h3>
            <SpeakButton text={lemma} variant="us" />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-md p-1 leading-none text-[var(--fg-soft)] transition hover:bg-[var(--bg-soft)] hover:text-[var(--fg)]"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
          {busy && !data && (
            <p className="text-sm text-[var(--fg-soft)]">加载中…</p>
          )}
          {attempts.length > 0 && !busy && (
            <AIErrorNotice attempts={attempts} />
          )}
          {data && (
            <ol className="space-y-4 list-none">
              {data.senses.map((s, i) => (
                <li key={i} className="space-y-2">
                  <div className="flex gap-2">
                    <span className="mt-0.5 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[var(--accent)]/12 px-1.5 text-[11px] font-medium text-[var(--accent)] tabular-nums">
                      {i + 1}
                    </span>
                    <p className="flex-1 text-[14px] leading-relaxed text-[var(--fg)]">
                      {s.def}
                    </p>
                  </div>
                  <div className="ml-7 rounded-[var(--radius-md)] border border-[var(--border)]/60 bg-[var(--bg-soft)]/40 p-3">
                    <div className="flex items-start gap-2">
                      <p className="flex-1 text-[13px] leading-relaxed text-[var(--fg)]">
                        {s.example.en}
                      </p>
                      <SpeakButton text={s.example.en} variant="us" />
                    </div>
                    {s.example.cn && (
                      <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--fg-soft)]">
                        {s.example.cn}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
          {/* Ephemeral usage footnote — only visible right after a fresh fetch,
              never for a cache hit (that would misleadingly imply we spent
              tokens on the reopen). */}
          {fresh && (
            <AIUsageNote model={fresh.model} usage={fresh.usage} />
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-[var(--border)]/60 px-5 py-2.5 shrink-0">
          <span className="text-[11px] text-[var(--fg-soft)]">
            {data
              ? `更新于 ${formatCachedAt(data.cachedAt)}`
              : busy
                ? "正在生成…"
                : ""}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => lemma && fetchAndCache(lemma, true)}
              disabled={busy}
              className="rounded-md border border-[var(--border)] px-2.5 py-1 text-xs transition hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "生成中…" : "再生成"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white transition hover:opacity-90"
            >
              关闭
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function formatCachedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `今天 ${hh}:${mm}`;
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  return `${M}/${D} ${hh}:${mm}`;
}
