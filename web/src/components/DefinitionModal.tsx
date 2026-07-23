"use client";

/**
 * <DefinitionModal /> — the popup behind the "释义" button on each wordbook row.
 *
 * Behaviour:
 *   - On open, tries the IndexedDB cache first. Cache hit → paint immediately.
 *   - Cache miss → POST /api/ai/definition, then persist the response so the
 *     next open is instant. Same fallback contract as the other /api/ai/*
 *     routes: if DeepSeek is unavailable the API returns a mock payload
 *     which we still render (with a small "mock" pill).
 *   - Renders 1–2 English definitions; each definition has an example
 *     sentence (with Chinese translation) that can be tapped to hear it via
 *     the shared <SpeakButton />.
 *   - Close options: click the ✕, click the backdrop, or press Esc.
 *   - "再生成" refetches and overwrites the cache — useful when the first
 *     response was a mock (no key) or the user simply wants another take.
 *
 * The component is fully self-contained; the parent only needs to toggle
 * the `lemma` prop (null = closed, string = show that word). Keeping the
 * open/close state driven by prop instead of a ref makes it trivial to
 * wire from any list row without prop-drilling a modal store.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import SpeakButton from "@/components/SpeakButton";
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
  provider: "deepseek" | "mock";
}

export default function DefinitionModal({ lemma, onClose }: Props) {
  const [data, setData] = useState<AIDefinition | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Track the lemma we're currently loading so a late response from a
  // previous open doesn't overwrite a newer one (e.g. rapid switch A→B).
  const activeLemmaRef = useRef<string | null>(null);

  const fetchAndCache = useCallback(
    async (target: string, forceRefresh: boolean) => {
      activeLemmaRef.current = target;
      setBusy(true);
      setErr(null);
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
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = (await res.json()) as ApiResponse;
        if (!Array.isArray(payload.senses) || payload.senses.length === 0) {
          throw new Error("empty response");
        }
        const saved = await saveDefinition(
          target,
          payload.senses,
          payload.provider,
        );
        // Guard: if the user has since switched lemmas, discard this result.
        if (activeLemmaRef.current === target) {
          setData(saved);
        }
      } catch (e) {
        if (activeLemmaRef.current === target) {
          setErr((e as Error).message || "load failed");
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
      setErr(null);
      setBusy(false);
      return;
    }
    setData(null);
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
            {data?.provider === "mock" && (
              <span className="rounded bg-[var(--bg-soft)] px-1.5 py-0.5 text-[10px] text-[var(--fg-soft)]">
                mock
              </span>
            )}
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

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {busy && !data && (
            <p className="text-sm text-[var(--fg-soft)]">加载中…</p>
          )}
          {err && !busy && (
            <p className="text-sm text-red-500">加载失败：{err}</p>
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
