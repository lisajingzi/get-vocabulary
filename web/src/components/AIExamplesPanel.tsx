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
 *   - After every fresh generation we show a single "🔢 N tokens · model"
 *     footnote under the newest entry. It disappears next mount (not cached).
 *   - When the API returns 502 (all Zhipu tiers failed) we render a red
 *     <AIErrorNotice> with the per-tier reasons and leave existing cached
 *     entries intact.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import HighlightedSentence from "@/components/HighlightedSentence";
import SpeakButton from "@/components/SpeakButton";
import {
  AIErrorNotice,
  AIUsageNote,
  parseAIErrorAttempts,
  type AIAttempt,
} from "@/components/AIStatus";
import {
  addExample,
  deleteExample,
  listExamples,
  type AIExample,
} from "@/lib/ai/example-cache";
import {
  getKnownLemmaSet,
  listKnownLemmasByRecency,
} from "@/lib/wordbook/local";
import type { DictSense } from "@/lib/types";

interface Props {
  lemma: string;
  senses: DictSense[];
}

interface FreshUsage {
  model: string;
  usage: { input: number; output: number; total: number };
}

export default function AIExamplesPanel({ lemma, senses }: Props) {
  const [senseIndex, setSenseIndex] = useState(-1); // -1 = primary
  const [history, setHistory] = useState<AIExample[]>([]);
  const [busy, setBusy] = useState(false);
  const [attempts, setAttempts] = useState<AIAttempt[]>([]);
  const [fresh, setFresh] = useState<FreshUsage | null>(null);

  const [knownLemmas, setKnownLemmas] = useState<string[]>(() =>
    typeof window === "undefined" ? [] : Array.from(getKnownLemmaSet()),
  );
  useEffect(() => {
    function refresh() {
      setKnownLemmas(Array.from(getKnownLemmaSet()));
    }
    refresh();
    if (typeof window !== "undefined") {
      window.addEventListener("get:wordbook-change", refresh);
      return () =>
        window.removeEventListener("get:wordbook-change", refresh);
    }
  }, []);

  const senseLabel = useMemo(() => {
    return (idx: number): string => {
      if (idx < 0) return "主要释义";
      const s = senses[idx];
      if (!s) return `释义 ${idx + 1}`;
      const summary = (s.chn || s.def || "").slice(0, 18);
      return summary ? `释义 ${idx + 1}·${summary}` : `释义 ${idx + 1}`;
    };
  }, [senses]);

  const refresh = useCallback(async () => {
    setHistory(await listExamples(lemma, senseIndex));
  }, [lemma, senseIndex]);

  const generate = useCallback(async () => {
    setBusy(true);
    setAttempts([]);
    setFresh(null);
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
      // 只用最近查询的 10 个词来组句。
      // listKnownLemmasByRecency 按 lastQueriedAt 降序，雅思批量导入的词没有 lastQueriedAt
      // 会自然排到尾部，不会占新鲜频道。回避当前词本身。
      const recent = listKnownLemmasByRecency(20)
        .filter((w) => w !== lemma)
        .slice(0, 10);
      const avoid = history.slice(0, 5).map((h) => h.en);
      const res = await fetch("/api/ai/example", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lemma, sense, known: recent, avoid }),
      });
      if (!res.ok) {
        setAttempts(await parseAIErrorAttempts(res));
        return;
      }
      const data = (await res.json()) as {
        en: string;
        cn: string;
        highlights: string[];
        model: string;
        usage: { input: number; output: number; total: number };
      };
      const saved = await addExample({
        lemma,
        senseIndex,
        en: data.en,
        cn: data.cn,
        highlights: data.highlights ?? [lemma],
      });
      setHistory((prev) => [saved, ...prev]);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lemma, senseIndex, senses, history]);

  // Mount + (lemma, senseIndex) change: load cache, then auto-generate iff empty.
  useEffect(() => {
    let cancelled = false;
    setHistory([]);
    setAttempts([]);
    setFresh(null);
    (async () => {
      const list = await listExamples(lemma, senseIndex);
      if (cancelled) return;
      setHistory(list);
      if (list.length === 0 && !busy) {
        void generate();
      }
    })();
    return () => {
      cancelled = true;
    };
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

      {attempts.length > 0 && !busy && <AIErrorNotice attempts={attempts} />}

      {history.length === 0 && !busy && attempts.length === 0 && (
        <p className="text-xs text-[var(--fg-soft)]">
          点击「生成例句」让 AI 给你造一句，会尽量串上你已经查过的旧词。
        </p>
      )}

      {history.length > 0 && (
        <ul className="space-y-2">
          {history.map((ex) => (
            <li
              key={ex.id}
              className="space-y-1 rounded-lg border border-[var(--border)] p-3"
            >
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
                <span>{new Date(ex.createdAt).toLocaleString("zh-CN")}</span>
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

      {fresh && <AIUsageNote model={fresh.model} usage={fresh.usage} />}
    </section>
  );
}
