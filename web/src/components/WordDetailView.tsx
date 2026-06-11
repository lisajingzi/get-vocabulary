"use client";

/**
 * <WordDetailView /> — client view used by /word/[slug].
 *
 * Responsibilities:
 *   1. Resolve the slug against the IndexedDB-cached dictionary.
 *   2. Show four states: loading / not-found / redirected / canonical.
 *   3. Record a successful lookup into the local wordbook UNLESS the user
 *      arrived from inside the wordbook list (`?from=wordbook`) — viewing
 *      from there mustn't bump query stats.
 *   4. Render the structured fields with comfortable Notion-style spacing,
 *      grouped by part of speech.
 *   5. Three-state membership pill: 新朋友 / 老朋友 / 不收藏, each click
 *      surfaces a toast so the user knows what happened.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AIExamplesPanel from "@/components/AIExamplesPanel";
import HighlightedSentence from "@/components/HighlightedSentence";
import NotesPanel from "@/components/NotesPanel";
import SpeakButton from "@/components/SpeakButton";
import { toast } from "@/components/Toast";
import { lookup, type LookupResult } from "@/lib/dict";
import {
  getEntry,
  getKnownLemmaSet,
  recordLookup,
  setStatus,
  type WordbookEntry,
  type WordbookStatus,
} from "@/lib/wordbook/local";

interface Props {
  slug: string;
  /** Origin marker from the URL. "wordbook" = clicked through from the
   *  wordbook list; anything else (or undefined) = a real search. */
  from?: string;
}

type State =
  | { kind: "loading" }
  | { kind: "not-found" }
  | { kind: "ok"; result: LookupResult };

export default function WordDetailView({ slug, from }: Props) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [bookEntry, setBookEntry] = useState<WordbookEntry | null>(null);

  // The route param has already been url-decoded by Next, but our store keys
  // are lowercase. Normalise once.
  const query = useMemo(() => slug.trim().toLowerCase(), [slug]);

  // Whether to count this mount as a fresh lookup. Stable per mount so even
  // if `from` changes mid-route we don't second-guess the original intent.
  const countAsLookupRef = useRef<boolean>(from !== "wordbook");

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    lookup(query)
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          setState({ kind: "not-found" });
          return;
        }
        setState({ kind: "ok", result });
        // Count this lookup. Using the canonical lemma so "abandoned" (alias)
        // and "abandon" (canonical) both consolidate under one wordbook entry.
        const firstPos = result.entry.senses[0]?.pos ?? undefined;
        recordLookup(result.lemma, firstPos, {
          skipCount: !countAsLookupRef.current,
        });
        setBookEntry(getEntry(result.lemma));
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "not-found" });
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  // Listen for wordbook changes from anywhere (e.g. user toggled status in
  // another tab) and keep our local mirror fresh.
  useEffect(() => {
    if (state.kind !== "ok") return;
    const lemma = state.result.lemma;
    function refresh() {
      setBookEntry(getEntry(lemma));
    }
    window.addEventListener("get:wordbook-change", refresh);
    return () => window.removeEventListener("get:wordbook-change", refresh);
  }, [state]);

  const handleToggleStatus = useCallback(
    (next: WordbookStatus) => {
      if (state.kind !== "ok") return;
      const previous = bookEntry?.status;
      const updated = setStatus(state.result.lemma, next);
      if (!updated) return;
      setBookEntry(updated);
      // Friendly feedback so the user actually feels the click.
      const label =
        next === "new" ? "新朋友" : next === "old" ? "老朋友" : "不收藏";
      const verb =
        previous && previous !== next ? "已移动到" : "已加入";
      toast(
        next === "archived"
          ? "已从单词本移除"
          : `${verb} ${label}`,
      );
    },
    [state, bookEntry?.status],
  );

  // Snapshot of "already-looked-up" lemmas; used to highlight them in every
  // dictionary example sentence on the page. Refresh on wordbook changes so
  // that adding a new word in a sibling tab updates the highlights here.
  const [knownLemmas, setKnownLemmas] = useState<string[]>([]);
  useEffect(() => {
    function refresh() {
      setKnownLemmas(Array.from(getKnownLemmaSet()));
    }
    refresh();
    window.addEventListener("get:wordbook-change", refresh);
    return () => window.removeEventListener("get:wordbook-change", refresh);
  }, []);

  // Back button — prefer router.back() so we land on whatever screen the
  // user came from (search results / wordbook / home). Falls back to "/".
  const handleBack = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push("/");
    }
  }, [router]);

  if (state.kind === "loading") {
    return (
      <div className="space-y-4">
        <BackButton onClick={handleBack} />
        <div className="h-8 w-40 animate-pulse rounded bg-[var(--bg-soft)]" />
        <div className="h-4 w-72 animate-pulse rounded bg-[var(--bg-soft)]" />
        <div className="h-4 w-64 animate-pulse rounded bg-[var(--bg-soft)]" />
      </div>
    );
  }

  if (state.kind === "not-found") {
    return (
      <div className="space-y-4">
        <BackButton onClick={handleBack} />
        <h1 className="text-2xl font-semibold">{query}</h1>
        <p className="text-sm text-[var(--fg-soft)]">
          牛津高阶词典里没有收录这个词。
        </p>
        <p className="text-sm text-[var(--fg-soft)]">
          检查拼写后再试，或者
          <Link href="/" className="ml-1 text-[var(--accent)] hover:underline">
            返回首页
          </Link>
          。
        </p>
      </div>
    );
  }

  const { result } = state;
  const { entry, redirected, query: typed, lemma } = result;

  // Group senses by part of speech so multi-pos entries (verb + noun) read
  // like the printed dictionary instead of an interleaved list.
  const groups = groupByPos(entry.senses);

  return (
    <div className="space-y-6">
      <BackButton onClick={handleBack} />

      {/* Header — lemma + phonetics + speak buttons */}
      <header className="space-y-1">
        {redirected && (
          <p className="text-xs text-[var(--fg-soft)]">
            <span className="font-medium text-[var(--fg)]">{typed}</span>
            <span className="mx-1">→</span>
            <span>原形 {lemma}</span>
          </p>
        )}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">
            {entry.lemma}
          </h1>
        </div>
        {(entry.phon?.uk || entry.phon?.us) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-[var(--fg-soft)]">
            {entry.phon?.uk && (
              <div className="inline-flex items-center gap-1">
                <span className="text-xs">英</span>
                <span>/{entry.phon.uk}/</span>
                <SpeakButton text={entry.lemma} variant="uk" />
              </div>
            )}
            {entry.phon?.us && (
              <div className="inline-flex items-center gap-1">
                <span className="text-xs">美</span>
                <span>/{entry.phon.us}/</span>
                <SpeakButton text={entry.lemma} variant="us" />
              </div>
            )}
          </div>
        )}

        {/* 新朋友 / 老朋友 / 不收藏 三段式开关。
            进入页面后立即显示，"不收藏"为默认未选中且与"新朋友"互斥。 */}
        {bookEntry && (
          <div className="flex items-center gap-2 pt-2">
            <FriendToggle
              status={bookEntry.status}
              onChange={handleToggleStatus}
            />
            <span className="text-xs text-[var(--fg-soft)]">
              已查 {bookEntry.queryCount} 次
            </span>
          </div>
        )}
      </header>

      {/* Senses */}
      {groups.map(([pos, senses], gi) => (
        <section key={`${pos}-${gi}`} className="space-y-3">
          {pos && (
            <h2 className="text-sm font-medium uppercase tracking-wide text-[var(--accent)]">
              {pos}
            </h2>
          )}
          <ol className="space-y-3">
            {senses.map((sense, si) => (
              <li
                key={si}
                className="rounded-lg border border-[var(--border)] p-4"
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--bg-soft)] text-xs text-[var(--fg-soft)]">
                    {si + 1}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    {sense.def && (
                      <p className="text-sm leading-relaxed">{sense.def}</p>
                    )}
                    {sense.chn && (
                      <p className="text-sm leading-relaxed text-[var(--fg-soft)]">
                        {sense.chn}
                      </p>
                    )}
                    {sense.ex && sense.ex.length > 0 && (
                      <ul className="mt-2 space-y-2 border-l border-[var(--border)] pl-3">
                        {sense.ex.map((ex, ei) => (
                          <li key={ei} className="space-y-0.5">
                            <div className="flex items-start gap-2">
                              <p className="flex-1 text-sm">
                                <HighlightedSentence
                                  text={ex.en}
                                  targetLemma={entry.lemma}
                                  knownLemmas={knownLemmas}
                                />
                              </p>
                              <SpeakButton text={ex.en} variant="us" />
                            </div>
                            {ex.cn && (
                              <p className="text-xs text-[var(--fg-soft)]">
                                {ex.cn}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}

      {/* AI 例句区（Day 4） */}
      <AIExamplesPanel lemma={entry.lemma} senses={entry.senses} />

      {/* 笔记区（Day 3a） */}
      <NotesPanel lemma={entry.lemma} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-sm text-[var(--fg-soft)] transition hover:text-[var(--fg)]"
      aria-label="返回上一页"
    >
      <span aria-hidden>←</span>
      <span>返回</span>
    </button>
  );
}

/**
 * Three-state pill for marking a word as 新朋友 / 老朋友 / 不收藏.
 *
 * Visual weight is intentionally subtle — this is a state indicator the user
 * glances at, not a primary action. The pill that matches `status` gets the
 * accent color; the other two are muted.
 */
function FriendToggle({
  status,
  onChange,
}: {
  status: WordbookStatus;
  onChange: (next: WordbookStatus) => void;
}) {
  const items: Array<{ key: WordbookStatus; label: string }> = [
    { key: "new", label: "新朋友" },
    { key: "old", label: "老朋友" },
    { key: "archived", label: "不收藏" },
  ];
  return (
    <div className="inline-flex rounded-md border border-[var(--border)] p-0.5">
      {items.map((it) => {
        const active = it.key === status;
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onChange(it.key)}
            className={[
              "rounded px-2.5 py-1 text-xs transition",
              active
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--fg-soft)] hover:text-[var(--fg)]",
            ].join(" ")}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Stable pos-grouping that preserves the dictionary's original sense order.
 *
 * We don't sort by pos — that would surface "noun" senses before the more
 * common "verb" ones for entries like `abandon`. Instead we walk the senses
 * in order and start a new group whenever the pos label changes.
 */
function groupByPos(
  senses: import("@/lib/types").DictSense[],
): Array<[string, import("@/lib/types").DictSense[]]> {
  const out: Array<[string, import("@/lib/types").DictSense[]]> = [];
  for (const s of senses) {
    const pos = s.pos ?? "";
    const last = out[out.length - 1];
    if (last && last[0] === pos) last[1].push(s);
    else out.push([pos, [s]]);
  }
  return out;
}
