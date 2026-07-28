"use client";

/**
 * <DerivedFormPanel /> — fills in a card for a "derived form" lemma whose
 * dictionary entry is just a cross-ref alias.
 *
 * Why this exists
 * ---------------
 * The bundled Oxford 9 mdx records many derived/inflected forms (`arousal`,
 * `youthful`, `kindness`, …) as `{ lemma, alias_of: "<base>" }` — they
 * resolve to the base entry without their own pos / phonetics / definition
 * / examples. The previous UI would silently show the BASE's content under
 * the user's typed word, which is misleading: `arousal` is a noun and
 * pronounced /əˈraʊzl/, not a verb /əˈraʊz/.
 *
 * This component asks `/api/ai/derived` for the derived form's *own*
 * dictionary information (pos / IPA / def / chn / 1–2 examples), grounded
 * by the base lemma's first sense, and renders it as a distinct card that
 * sits ABOVE the (kept) base entry content. Results are cached in
 * `localStorage` so a second visit is instant and free.
 *
 * Failure modes
 * -------------
 * - No DEEPSEEK key → server returns a clearly-marked mock; we still render
 *   it so the UI flows, with a "(模拟数据)" provider tag.
 * - Network/parse error → we surface a friendly message + a 重试 button;
 *   the page still has the base entry below as a usable fallback.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import SpeakButton from "@/components/SpeakButton";
import type { DictSense } from "@/lib/types";

interface DerivedExample {
  en: string;
  cn: string;
}

interface DerivedInfo {
  pos: string;
  phonUk?: string;
  phonUs?: string;
  def: string;
  chn: string;
  examples: DerivedExample[];
  provider: "deepseek" | "mock";
  /** Present iff provider="mock" — human-readable upstream error. */
  mockReason?: string;
}

interface Props {
  /** The form the user actually searched (e.g. "arousal"). */
  derived: string;
  /** The canonical lemma the dictionary redirected to (e.g. "arouse"). */
  base: string;
  /** First sense of the base entry — used to ground the model. */
  baseSense?: DictSense;
  /** Fired whenever we successfully populate (or re-populate) `info`,
   *  including from cache. Lets the parent backfill the wordbook entry's
   *  pos with the DERIVED form's pos (noun for `arousal`) instead of the
   *  base lemma's pos (verb for `arouse`). */
  onResolved?: (info: DerivedInfo) => void;
}

const CACHE_PREFIX = "get:derived-info:v1:";

function readCache(derived: string, base: string): DerivedInfo | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_PREFIX + derived + "→" + base);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DerivedInfo;
    if (!parsed.pos || !parsed.def) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(derived: string, base: string, info: DerivedInfo) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CACHE_PREFIX + derived + "→" + base,
      JSON.stringify(info),
    );
  } catch {
    // Quota errors are non-fatal — the next visit just re-fetches.
  }
}

function clearCache(derived: string, base: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(CACHE_PREFIX + derived + "→" + base);
  } catch {
    // ignore
  }
}

export default function DerivedFormPanel({ derived, base, baseSense, onResolved }: Props) {
  const [info, setInfo] = useState<DerivedInfo | null>(() =>
    readCache(derived, base),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Keep the latest onResolved without retriggering effects when the parent
  // hands us a fresh function reference each render.
  const onResolvedRef = useRef(onResolved);
  useEffect(() => {
    onResolvedRef.current = onResolved;
  }, [onResolved]);

  const fetchInfo = useCallback(
    async (skipCache = false) => {
      setBusy(true);
      setErr(null);
      try {
        if (!skipCache) {
          const cached = readCache(derived, base);
          if (cached) {
            setInfo(cached);
            onResolvedRef.current?.(cached);
            setBusy(false);
            return;
          }
        }
        const res = await fetch("/api/ai/derived", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            derived,
            base,
            baseSense: baseSense
              ? {
                  def: baseSense.def,
                  chn: baseSense.chn,
                  pos: baseSense.pos,
                }
              : undefined,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as DerivedInfo;
        if (!data.pos || !data.def) {
          throw new Error("incomplete payload");
        }
        setInfo(data);
        onResolvedRef.current?.(data);
        writeCache(derived, base, data);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [derived, base, baseSense],
  );

  // Auto-fire on mount / when the (derived, base) pair changes, unless we
  // already have a cached payload — in which case fire onResolved with the
  // cached value so the parent (wordbook entry) can still backfill its pos.
  useEffect(() => {
    const cached = readCache(derived, base);
    if (cached) {
      setInfo(cached);
      onResolvedRef.current?.(cached);
      return;
    }
    void fetchInfo(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived, base]);

  const onRegenerate = useCallback(() => {
    clearCache(derived, base);
    setInfo(null);
    void fetchInfo(true);
  }, [derived, base, fetchInfo]);

  return (
    <section
      className="space-y-3 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent-soft)]/40 p-4"
      aria-label={`${derived} 自身释义`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-[var(--accent)]">
          {derived} · 释义（AI 补全）
        </h2>
        <div className="flex items-center gap-2">
          {info?.provider === "mock" && (
            <span
              className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--fg-soft)] cursor-help"
              title={info.mockReason ? `AI 不可用：${info.mockReason}` : undefined}
            >
              模拟数据
            </span>
          )}
          <button
            type="button"
            onClick={onRegenerate}
            disabled={busy}
            className="rounded-md border border-[var(--border)] px-2.5 py-1 text-xs transition hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
            title={`重新让 AI 生成 ${derived} 的释义`}
          >
            {busy ? "生成中…" : "重新生成"}
          </button>
        </div>
      </div>

      {err && (
        <p className="text-xs text-red-500">
          生成失败：{err}（可点击「重新生成」重试，下方仍是「{base}」的完整词条）
        </p>
      )}

      {!info && busy && (
        <div className="space-y-2">
          <div className="h-4 w-2/3 animate-pulse rounded bg-[var(--bg-soft)]" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-[var(--bg-soft)]" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-[var(--bg-soft)]" />
        </div>
      )}

      {info && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
            <span className="rounded bg-[var(--bg-soft)] px-1.5 py-0.5 text-xs text-[var(--fg-soft)]">
              {info.pos}
            </span>
            {info.phonUk && (
              <span className="inline-flex items-center gap-1 text-[var(--fg-soft)]">
                <span className="text-xs">英</span>
                <span>/{info.phonUk}/</span>
                <SpeakButton text={derived} variant="uk" />
              </span>
            )}
            {info.phonUs && (
              <span className="inline-flex items-center gap-1 text-[var(--fg-soft)]">
                <span className="text-xs">美</span>
                <span>/{info.phonUs}/</span>
                <SpeakButton text={derived} variant="us" />
              </span>
            )}
            {!info.phonUk && !info.phonUs && (
              <SpeakButton text={derived} variant="us" />
            )}
          </div>

          <p className="text-sm leading-relaxed">{info.def}</p>
          {info.chn && (
            <p className="text-sm leading-relaxed text-[var(--fg-soft)]">
              {info.chn}
            </p>
          )}

          {info.examples.length > 0 && (
            <ul className="mt-1 space-y-2 border-l border-[var(--border)] pl-3">
              {info.examples.map((ex, i) => (
                <li key={i} className="space-y-0.5">
                  <div className="flex items-start gap-2">
                    <p className="flex-1 text-sm">{ex.en}</p>
                    <SpeakButton text={ex.en} variant="us" />
                  </div>
                  {ex.cn && (
                    <p className="text-xs text-[var(--fg-soft)]">{ex.cn}</p>
                  )}
                </li>
              ))}
            </ul>
          )}

          <p className="text-xs text-[var(--fg-soft)]">
            说明：「{derived}」在牛津高阶词典里没有独立词条，
            以上内容由 AI 基于其原形「{base}」生成，仅供参考；
            完整原形释义见下方「派生关系参考」。
          </p>
        </div>
      )}
    </section>
  );
}
