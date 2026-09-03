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
 * the user's typed word, which is misleading.
 *
 * This component asks `/api/ai/derived` for the derived form's *own*
 * dictionary information (pos / IPA / def / chn / 1–2 examples), grounded
 * by the base lemma's first sense, and renders it as a distinct card that
 * sits ABOVE the (kept) base entry content. Results are cached in
 * `localStorage` so a second visit is instant and free.
 *
 * Failure modes
 * -------------
 * - All three fallback tiers of the Zhipu chain failed → we render a red
 *   <AIErrorNotice> listing each tier's translated reason. The user still
 *   sees the base entry below as a usable fallback.
 * - Successful call → we show a small "🔢 N tokens · model" footnote once,
 *   for as long as the panel is mounted. The footnote is NOT persisted;
 *   reopening the page later just shows the cached content silently.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import SpeakButton from "@/components/SpeakButton";
import {
  AIErrorNotice,
  AIUsageNote,
  parseAIErrorAttempts,
  type AIAttempt,
} from "@/components/AIStatus";
import type { DictSense } from "@/lib/types";
import { useHideChinese } from "@/lib/ui/hide-chinese";

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
}

interface FreshUsage {
  model: string;
  usage: { input: number; output: number; total: number };
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
  const [attempts, setAttempts] = useState<AIAttempt[]>([]);
  const [fresh, setFresh] = useState<FreshUsage | null>(null);
  const hideChinese = useHideChinese();

  // Keep the latest onResolved without retriggering effects when the parent
  // hands us a fresh function reference each render.
  const onResolvedRef = useRef(onResolved);
  useEffect(() => {
    onResolvedRef.current = onResolved;
  }, [onResolved]);

  const fetchInfo = useCallback(
    async (skipCache = false) => {
      setBusy(true);
      setAttempts([]);
      setFresh(null);
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
        if (!res.ok) {
          setAttempts(await parseAIErrorAttempts(res));
          return;
        }
        const data = (await res.json()) as DerivedInfo & FreshUsage;
        if (!data.pos || !data.def) {
          setAttempts([{ model: "parse", reason: "模型返回内容无法解析" }]);
          return;
        }
        const clean: DerivedInfo = {
          pos: data.pos,
          phonUk: data.phonUk,
          phonUs: data.phonUs,
          def: data.def,
          chn: data.chn,
          examples: data.examples,
        };
        setInfo(clean);
        onResolvedRef.current?.(clean);
        writeCache(derived, base, clean);
        if (data.model && data.usage) {
          setFresh({ model: data.model, usage: data.usage });
        }
      } catch (e) {
        setAttempts([
          { model: "network", reason: (e as Error).message || "网络请求失败" },
        ]);
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

      {attempts.length > 0 && !busy && (
        <AIErrorNotice
          attempts={attempts}
          hint={`下方仍是「${base}」的完整词条，可先参考`}
        />
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
          {info.chn && !hideChinese && (
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
                  {ex.cn && !hideChinese && (
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

          {fresh && (
            <AIUsageNote model={fresh.model} usage={fresh.usage} />
          )}
        </div>
      )}
    </section>
  );
}
