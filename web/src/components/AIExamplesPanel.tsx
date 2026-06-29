"use client";

/**
 * <AIExamplesPanel /> — AI-generated example sentence area on the word page.
 *
 * Behaviour:
 *   - On first mount, lists cached generations for (lemma, currentSenseIndex).
 *     If the cache is empty for that pair, auto-fires ONE generation. Cached
 *     generations are NEVER re-fired — only the user's "再生成" click does.
 *   - Default sense index is -1 ("primary"). User can pick any specific sense
 *     from a dropdown to ground future generations on that meaning.
 *   - Highlights show the target lemma (strong) + any of the user's wordbook
 *     lemmas the model wove in (soft); both are clickable.
 *   - Each cached entry is individually deletable.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import HighlightedSentence from "@/components/HighlightedSentence";
import SpeakButton from "@/components/SpeakButton";
import {
  addExample,
  deleteExample,
  listExamples,
  type AIExample,
} from "@/lib/ai/example-cache";
import { getKnownLemmaSet } from "@/lib/wordbook/local";
import type { DictSense } from "@/lib/types";

interface Props {
  lemma: string;
  senses: DictSense[];
}

export default function AIExamplesPanel({ lemma, senses }: Props) {
  const [senseIndex, setSenseIndex] = useState(-1); // -1 = primary
  const [history, setHistory] = useState<AIExample[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Snapshot of every wordbook lemma; passed into HighlightedSentence so the
  // soft-highlight covers ALL the user's known words, not just the ones the
  // model happened to flag in `highlights`. Keeps the visual signal consistent
  // across cached and freshly generated examples.
  //
  // Lazy initializer reads localStorage on the FIRST render so cached examples
  // get their highlights painted on the very first paint instead of flashing
  // "black, then highlighted" when the useEffect lands a tick later. Falls
  // back to an empty array during SSR (no window).
  const [knownLemmas, setKnownLemmas] = useState<string[]>(() =>
    typeof window === "undefined" ? [] : Array.from(getKnownLemmaSet()),
  );
  useEffect(() => {
    function refresh() {
      setKnownLemmas(Array.from(getKnownLemmaSet()));
    }
    // Re-read once on mount in case SSR hydration produced a stale empty
    // array (it shouldn't, but defensive).
    refresh();
    if (typeof window !== "undefined") {
      window.addEventListener("get:wordbook-change", refresh);
      return () =>
        window.removeEventListener("get:wordbook-change", refresh);
    }
  }, []);

  // Human-friendly label for a given senseIndex. -1 collapses to "主要释义".
  const senseLabel = useMemo(() => {
    return (idx: number): string => {
      if (idx < 0) return "主要释义";
      const s = senses[idx];
      if (!s) return `释义 ${idx + 1}`;
      const summary = (s.chn || s.def || "").slice(0, 18);
      return summary ? `释义 ${idx + 1}·${summary}` : `释义 ${idx + 1}`;
    };
  }, [senses]);

  // Reset whenever the lemma or selected sense changes — we treat each
  // (lemma, senseIndex) pair as its own thread of history.
  const refresh = useCallback(async () => {
    setHistory(await listExamples(lemma, senseIndex));
  }, [lemma, senseIndex]);

  const generate = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const sense =
        senseIndex >= 0 && senses[senseIndex]
          ? {
              def: senses[senseIndex].def,
              chn: senses[senseIndex].chn,
              pos: senses[senseIndex].pos,
            }
          : senses[0]
            ? {
                def: senses[0].def,
                chn: senses[0].chn,
                pos: senses[0].pos,
              }
            : undefined;
      const known = Array.from(getKnownLemmaSet()).filter((w) => w !== lemma);
      // Pass the most recent generations back to the API so the prompt can
      // explicitly tell the model "don't echo these". Without this the
      // model happily produces near-duplicates on every "再生成" click —
      // same scenario, same verbs, just one word swapped.
      const avoid = history.slice(0, 5).map((h) => h.en);
      const res = await fetch("/api/ai/example", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lemma, sense, known: known.slice(0, 50), avoid }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        en: string;
        cn: string;
        highlights: string[];
        provider: "deepseek" | "mock";
      };
      const saved = await addExample({
        lemma,
        senseIndex,
        en: data.en,
        cn: data.cn,
        highlights: data.highlights ?? [lemma],
        provider: data.provider,
      });
      setHistory((prev) => [saved, ...prev]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
    // history is in the dep list because we read it above to build the avoid
    // payload; if we left it out the closure would always see the initial
    // empty array and the avoid-list would never actually reach the model.
    // The auto-generate effect below pins itself to (lemma, senseIndex) only
    // and explicitly disables exhaustive-deps, so the new generate identity
    // here doesn't retrigger it.
  }, [lemma, senseIndex, senses, history]);

  // Mount + (lemma, senseIndex) change: load cache, then auto-generate iff empty.
  // We CLEAR `history` first so the previous sense's examples don't linger
  // on screen for the split second between switching the dropdown and the
  // async load coming back.
  useEffect(() => {
    let cancelled = false;
    setHistory([]);
    (async () => {
      const list = await listExamples(lemma, senseIndex);
      if (cancelled) return;
      setHistory(list);
      if (list.length === 0 && !busy) {
        // Fire-and-forget; the function flips its own busy state.
        void generate();
      }
    })();
    return () => {
      cancelled = true;
    };
    // intentional: we don't want re-runs on `generate` identity changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lemma, senseIndex]);

  async function handleDelete(id: string) {
    await deleteExample(id);
    refresh();
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-[var(--accent)]">
          AI 例句
        </h2>
        <div className="flex items-center gap-2">
          {senses.length > 1 && (
            <select
              value={senseIndex}
              onChange={(e) => setSenseIndex(Number(e.target.value))}
              className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--fg)] outline-none"
              aria-label="选择释义"
            >
              <option value={-1}>主要释义</option>
              {senses.map((s, i) => (
                <option key={i} value={i}>
                  {`${i + 1}. ${(s.chn || s.def || "").slice(0, 24)}`}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={generate}
            disabled={busy}
            className="rounded-md border border-[var(--border)] px-2.5 py-1 text-xs transition hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "生成中…" : history.length === 0 ? "生成例句" : "再生成"}
          </button>
        </div>
      </div>

      {err && (
        <p className="text-xs text-red-500">生成失败：{err}</p>
      )}

      {history.length === 0 && !busy && (
        <p className="text-xs text-[var(--fg-soft)]">
          点击「生成例句」让 AI 给你造一句，会尽量串上你已经查过的旧词。
        </p>
      )}

      {history.length > 0 && (
        <ul className="space-y-2">
          {history.map((ex, i) => (
            <li
              key={ex.id}
              className="space-y-1 rounded-lg border border-[var(--border)] p-3"
            >
              {/* Per-example sense badge so it's obvious which meaning this
                  sentence belongs to — prevents the "why is the old example
                  still here?" confusion when flipping the dropdown. */}
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center rounded-full bg-[var(--bg-soft)] px-2 py-0.5 text-[11px] text-[var(--fg-soft)]">
                  {senseLabel(ex.senseIndex)}
                </span>
              </div>
              <div className="flex items-start gap-2">
                <p className="flex-1 text-sm leading-relaxed">
                  <HighlightedSentence
                    text={ex.en}
                    targetLemma={lemma}
                    knownLemmas={knownLemmas}
                  />
                </p>
                <SpeakButton text={ex.en} variant="us" />
              </div>
              {ex.cn && (
                <p className="text-xs text-[var(--fg-soft)]">{ex.cn}</p>
              )}
              <div className="flex items-center justify-between text-[11px] text-[var(--fg-soft)]">
                <span>
                  {new Date(ex.createdAt).toLocaleString("zh-CN")}
                  {ex.provider === "mock" && i === 0 && (
                    <span className="ml-2 rounded bg-[var(--bg-soft)] px-1.5 py-0.5">
                      mock
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => handleDelete(ex.id)}
                  className="hover:text-red-500"
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
