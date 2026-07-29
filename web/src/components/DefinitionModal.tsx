"use client";

/**
 * <DefinitionModal /> — the popup behind the "释义" button on each wordbook row.
 *
 * Data source: 100% local Oxford 9 dictionary (via `lookup()`). No AI, no
 * network, no IndexedDB cache — the entry ships in the /dict shard the user
 * already downloaded, so opening the popup is instant and works offline.
 *
 * What we show:
 *   - Up to 2 senses, taken as the first two `DictSense` from the entry
 *     (the mdx parser already orders them by Oxford's own frequency).
 *   - For each sense: the English `def`, then ONE example (`ex[0]`) if the
 *     sense carries any. Both the headword and each example sentence have
 *     a SpeakButton so the user can tap-to-hear.
 *   - Per product spec: English definitions only in the sense line; Chinese
 *     lives under the example as a semantic anchor for the sentence.
 *   - If the dictionary has no entry for this lemma (redirects also fail),
 *     we show a small "词典中未收录该词" notice instead of any fallback.
 *
 * Close options: click the ✕, click the backdrop, press Esc, or the 关闭
 * button in the footer.
 */

import { useEffect, useState } from "react";
import SpeakButton from "@/components/SpeakButton";
import { lookup } from "@/lib/dict";
import type { DictSense } from "@/lib/types";

interface Props {
  /** Which lemma to show. `null` → modal is closed. */
  lemma: string | null;
  onClose: () => void;
}

interface DisplayState {
  /** The canonical lemma we ended up displaying (aliases followed). */
  headword: string;
  senses: DictSense[];
}

export default function DefinitionModal({ lemma, onClose }: Props) {
  const [state, setState] = useState<DisplayState | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);

  // Load whenever the target lemma changes. `lookup()` is async (it may need
  // to fetch a shard from /dict on first hit) but subsequent opens for the
  // same shard resolve synchronously from IndexedDB → in-memory cache.
  useEffect(() => {
    if (!lemma) {
      setState(null);
      setNotFound(false);
      setBusy(false);
      return;
    }
    let cancelled = false;
    setState(null);
    setNotFound(false);
    setBusy(true);
    (async () => {
      try {
        const result = await lookup(lemma);
        if (cancelled) return;
        if (!result) {
          setNotFound(true);
        } else {
          setState({
            headword: result.lemma,
            senses: result.entry.senses.slice(0, 2),
          });
        }
      } catch {
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lemma]);

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
              {state?.headword ?? lemma}
            </h3>
            <SpeakButton text={state?.headword ?? lemma} variant="us" />
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
          {busy && !state && (
            <p className="text-sm text-[var(--fg-soft)]">加载中…</p>
          )}
          {notFound && !busy && (
            <p className="text-sm text-[var(--fg-soft)]">词典中未收录该词。</p>
          )}
          {state && state.senses.length === 0 && (
            <p className="text-sm text-[var(--fg-soft)]">
              该词条暂无可展示的释义。
            </p>
          )}
          {state && state.senses.length > 0 && (
            <ol className="space-y-4 list-none">
              {state.senses.map((s, i) => {
                const ex = s.ex && s.ex.length > 0 ? s.ex[0] : null;
                return (
                  <li key={i} className="space-y-2">
                    <div className="flex gap-2">
                      <span className="mt-0.5 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[var(--accent)]/12 px-1.5 text-[11px] font-medium text-[var(--accent)] tabular-nums">
                        {i + 1}
                      </span>
                      <div className="flex-1 space-y-1">
                        {s.pos && (
                          <p className="text-[11px] uppercase tracking-wide text-[var(--fg-soft)]">
                            {s.pos}
                          </p>
                        )}
                        <p className="text-[14px] leading-relaxed text-[var(--fg)]">
                          {s.def || "（该义项暂无英文释义）"}
                        </p>
                      </div>
                    </div>
                    {ex && (
                      <div className="ml-7 rounded-[var(--radius-md)] border border-[var(--border)]/60 bg-[var(--bg-soft)]/40 p-3">
                        <div className="flex items-start gap-2">
                          <p className="flex-1 text-[13px] leading-relaxed text-[var(--fg)]">
                            {ex.en}
                          </p>
                          <SpeakButton text={ex.en} variant="us" />
                        </div>
                        {ex.cn && (
                          <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--fg-soft)]">
                            {ex.cn}
                          </p>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--border)]/60 px-5 py-2.5 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white transition hover:opacity-90"
          >
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
