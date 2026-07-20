"use client";

/**
 * <WordDetailView /> — client view used by /word/[slug].
 *
 * Responsibilities:
 *   1. Resolve the slug against the IndexedDB-cached dictionary.
 *   2. Show four states: loading / not-found / redirected / canonical.
 *   3. Record a successful lookup into the local wordbook UNLESS the user
 *      arrived from inside the wordbook list (`?from=wordbook`) — viewing
 *      from there mustn't bump query stats. Words missing from the
 *      dictionary do NOT auto-record on visit; they only enter the
 *      wordbook the moment the user saves their first note (and picks a
 *      pos at the same time), so empty visits don't pollute the list.
 *   4. Render the structured fields with comfortable Notion-style spacing,
 *      grouped by part of speech.
 *   5. Three-state membership pill: 新朋友 / 老朋友 / 不收藏, each click
 *      surfaces a toast so the user knows what happened.
 *   6. For not-found words, expose a NotesPanel with a required pos picker
 *      so the user can write their own definitions / examples / scratch
 *      notes against that word and have it classified in 单词本.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AIExamplesPanel from "@/components/AIExamplesPanel";
import DerivedFormPanel from "@/components/DerivedFormPanel";
import HighlightedSentence from "@/components/HighlightedSentence";
import NotesPanel from "@/components/NotesPanel";
import SpeakButton from "@/components/SpeakButton";
import { toast } from "@/components/Toast";
import { lookup, type LookupResult } from "@/lib/dict";
import type { DictPhrase } from "@/lib/types";
import {
  getEntry,
  getKnownLemmaSet,
  recordLookup,
  setPos,
  setPurpose,
  setStatus,
  type WordbookEntry,
  type WordbookPurpose,
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
  //
  // Sources that must NOT inflate queryCount / lastQueriedAt:
  //   • `wordbook`  — re-entering an already-known word from the list.
  //   • `review`    — clicking the headword during a review session to peek
  //                   at the meaning is part of studying, not a new lookup.
  const countAsLookupRef = useRef<boolean>(
    from !== "wordbook" && from !== "review",
  );

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    lookup(query)
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          setState({ kind: "not-found" });
          // Do NOT auto-record this lookup — for words the dictionary
          // doesn't carry, we only want to create a wordbook entry once
          // the user actively writes a note (and picks a pos). That keeps
          // "typo / curiosity" visits from cluttering 新朋友本. We DO mirror
          // any pre-existing entry so the membership pill renders correctly
          // for words the user has already taken notes on.
          setBookEntry(getEntry(query));
          return;
        }
        setState({ kind: "ok", result });
        // Count this lookup against THE WORD THE USER TYPED, not the
        // canonical headword we resolved to. So "arousal" (alias) stays
        // "arousal" in the wordbook even though we render "arouse"'s
        // senses underneath as derivation context. Likewise an inflected
        // form ("abandoned") is recorded under the form the user actually
        // looked up — the wordbook is meant to reflect their query history,
        // not the dictionary's normalisation.
        //
        // POS handling:
        //   • redirected (alias) → the dictionary's senses[0].pos belongs to
        //     the BASE form (verb for `arouse`), which is wrong for the
        //     derived form (`arousal` is a noun). Skip the pos here and let
        //     <DerivedFormPanel>'s onResolved callback backfill it once the
        //     LLM tells us the real derived-form pos.
        //   • not redirected (canonical lookup) → senses[0].pos is correct.
        const firstPos = result.redirected
          ? undefined
          : (result.entry.senses[0]?.pos ?? undefined);
        recordLookup(result.query, firstPos, {
          skipCount: !countAsLookupRef.current,
        });
        setBookEntry(getEntry(result.query));
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "not-found" });
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  // Listen for wordbook changes from anywhere (e.g. user toggled status in
  // another tab) and keep our local mirror fresh. Both branches key off the
  // user's typed query — that's what recordLookup() persisted above and what
  // the wordbook list shows.
  useEffect(() => {
    let lemma: string | null = null;
    if (state.kind === "ok") lemma = state.result.query;
    else if (state.kind === "not-found") lemma = query;
    if (!lemma) return;
    const key = lemma;
    function refresh() {
      setBookEntry(getEntry(key));
    }
    window.addEventListener("get:wordbook-change", refresh);
    return () => window.removeEventListener("get:wordbook-change", refresh);
  }, [state, query]);

  // Manual status toggle is intentionally limited to {"new", "archived"}.
  // Graduating to "old" (老朋友) is the EXCLUSIVE responsibility of the
  // Ebbinghaus review flow — letting the user flip it manually here would
  // bypass the spaced-repetition curve entirely, which defeats the purpose
  // of having one. If a word is already "old" we render a read-only badge
  // (see FriendBadge below) instead of an interactive switch.
  const handleToggleStatus = useCallback(
    (next: "new" | "archived") => {
      // Pick the right key for whichever branch we're rendering. Both
      // branches key off the user's typed query (see recordLookup above).
      let lemma: string | null = null;
      if (state.kind === "ok") lemma = state.result.query;
      else if (state.kind === "not-found") lemma = query;
      if (!lemma) return;
      const previous = bookEntry?.status;
      const updated = setStatus(lemma, next);
      if (!updated) return;
      setBookEntry(updated);
      const label = next === "new" ? "新朋友" : "不收藏";
      const verb = previous && previous !== next ? "已移动到" : "已加入";
      toast(
        next === "archived"
          ? "已从单词本移除"
          : `${verb} ${label}`,
      );
    },
    [state, query, bookEntry?.status],
  );

  // Change the word's review-flow purpose (听说写 vs 阅读). Same lemma-
  // resolution rules as handleToggleStatus above.
  const handleTogglePurpose = useCallback(
    (next: WordbookPurpose) => {
      let lemma: string | null = null;
      if (state.kind === "ok") lemma = state.result.query;
      else if (state.kind === "not-found") lemma = query;
      if (!lemma) return;
      const updated = setPurpose(lemma, next);
      if (!updated) return;
      setBookEntry(updated);
      toast(next === "active" ? "已标为听说写词" : "已标为阅读词");
    },
    [state, query],
  );

  // Snapshot of "already-looked-up" lemmas; used to highlight them in every
  // dictionary example sentence on the page. Lazy-initialized so first paint
  // already has the data (avoids the brief "black, then highlighted" flash
  // on slower devices). Refresh on wordbook changes so adding a new word in
  // a sibling tab updates the highlights here.
  const [knownLemmas, setKnownLemmas] = useState<string[]>(() =>
    typeof window === "undefined" ? [] : Array.from(getKnownLemmaSet()),
  );
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

  // Called by NotesPanel the moment the user saves their FIRST note for a
  // not-found word. We create the wordbook entry now (not on page enter), so
  // visits without notes don't end up in 新朋友本. The chosen pos comes from
  // the chip picker the user just confirmed.
  //
  // NOTE: we deliberately DON'T forward `skipCount` here. That flag exists
  // to prevent re-entering from the wordbook list from inflating queryCount,
  // but the user actively writing a note IS an explicit "create this entry"
  // intent — it must always materialize the row, even if the page was opened
  // via ?from=wordbook (which would early-return and produce no entry).
  const handleFirstNoteSave = useCallback(
    ({ pos }: { pos: string }) => {
      const created = recordLookup(query, pos);
      if (created) {
        setBookEntry(created);
        toast(`已加入 新朋友 · ${pos}`);
      }
    },
    [query],
  );

  // Called when the user changes the pos chip after the entry already exists.
  const handlePosChange = useCallback(
    (pos: string) => {
      const updated = setPos(query, pos);
      if (updated) {
        setBookEntry(updated);
        toast(`词性已更新为 ${pos}`);
      }
    },
    [query],
  );

  // Called by <DerivedFormPanel> as soon as it has the LLM-resolved info for
  // the derived form (either fresh from the API or from cache). We use the
  // returned `pos` to backfill the wordbook entry — the original recordLookup
  // for redirected words deliberately skipped pos because the dictionary only
  // knew the BASE form's pos (e.g. verb for "arouse"), which is wrong for
  // "arousal".
  //
  // We DO NOT overwrite a pos that's already there. If the entry already has
  // a pos it was either (a) set by a previous resolution we trust, or (b)
  // manually picked by the user via the chip on this same screen — either
  // way, the AI shouldn't quietly change it.
  const handleDerivedResolved = useCallback(
    (info: { pos: string }) => {
      if (!info.pos) return;
      // Read fresh, not from `bookEntry` state, because this fires soon
      // after recordLookup writes the row and our local mirror may not
      // have caught up yet via the wordbook-change listener.
      const current = getEntry(state.kind === "ok" ? state.result.query : query);
      if (!current) return;
      if (current.pos) return; // respect the user's prior choice
      const updated = setPos(current.lemma, info.pos);
      if (updated) setBookEntry(updated);
    },
    [state, query],
  );

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
    // Word isn't in the Oxford shards. We still let the user keep notes on
    // it (definitions, examples, anything they want) — those notes survive
    // page reloads, follow the word into /wordbook, and show up during
    // review. Storage key = the user's typed query (lowercased), same as
    // what recordLookup() persisted above.
    return (
      <div className="space-y-6">
        <BackButton onClick={handleBack} />

        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">{query}</h1>
          <p className="text-sm text-[var(--fg-soft)]">
            牛津高阶词典里没有收录这个词。你可以在下方写下自己的释义、例句和笔记，它们会保留在单词本里，下次再查或复习这个词时都能看到。
          </p>
          <p className="text-xs text-[var(--fg-soft)]">
            如果只是拼写出错，可以
            <Link href="/" className="ml-1 text-[var(--accent)] hover:underline">
              返回首页
            </Link>
            重新搜索。
          </p>

          {/* Same 新朋友 / 不收藏 toggle as canonical entries. "老朋友" is
              still owned exclusively by the review flow. */}
          {bookEntry && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {bookEntry.status === "old" ? (
                <FriendBadge />
              ) : (
                <FriendToggle
                  status={bookEntry.status}
                  onChange={handleToggleStatus}
                />
              )}
              <PurposeToggle
                purpose={bookEntry.purpose ?? "active"}
                onChange={handleTogglePurpose}
              />
              <span className="text-xs text-[var(--fg-soft)]">
                已查 {bookEntry.queryCount} 次
              </span>
            </div>
          )}
        </header>

        <NotesPanel
          lemma={query}
          requirePosOnFirstSave
          initialPos={bookEntry?.pos}
          onFirstSave={handleFirstNoteSave}
          onPosChange={handlePosChange}
        />
      </div>
    );
  }

  const { result } = state;
  const { entry, redirected, query: typed, lemma } = result;

  // Group senses by part of speech so multi-pos entries (verb + noun) read
  // like the printed dictionary instead of an interleaved list.
  const groups = groupByPos(entry.senses);

  // When the user typed an inflected/alias form (e.g. "arousal"), we still
  // want the headline to be THEIR word — not the canonical lemma we resolved
  // to. The dictionary content (phonetics, senses) below remains the
  // canonical entry's, since aliases don't carry their own definitions.
  const headword = redirected ? typed : entry.lemma;
  // Tiny lead-in shown on the canonical block so the user understands why
  // the senses below are listed under a different headword.
  const firstPos = entry.senses[0]?.pos;
  const firstChn = entry.senses[0]?.chn;
  const firstDef = entry.senses[0]?.def;
  const lemmaSummary = firstChn || firstDef || "";

  return (
    <div className="space-y-6">
      <BackButton onClick={handleBack} />

      {/* Header — lemma + phonetics + speak buttons */}
      <header className="space-y-1">
        {redirected && (
          <p className="text-xs text-[var(--fg-soft)]">
            <span>原形</span>
            <span className="mx-1">→</span>
            <span className="font-medium text-[var(--fg)]">{lemma}</span>
          </p>
        )}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">
            {headword}
          </h1>
        </div>
        {/* Phonetics row only renders for non-redirected entries.
            For an alias like "arousal" → "arouse", `entry.phon` belongs
            to `arouse` and would mispronounce the headword. The accurate
            IPA for the derived form is rendered by <DerivedFormPanel />
            below using AI-supplied data. */}
        {!redirected && (entry.phon?.uk || entry.phon?.us) && (
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

        {/* 新朋友 / 不收藏 二选一开关。
            "老朋友" 状态由艾宾浩斯打卡流程自动产生（level 升到 7 时），
            这里不能手动切换 —— 否则就绕过了复习曲线。已是老朋友的词，
            位置上换成只读徽标 <FriendBadge />。
            右侧附带一个 听说写 / 阅读 开关，控制这个词走哪套复习流程。 */}
        {bookEntry && (
          <div className="flex flex-wrap items-center gap-2 pt-2">
            {bookEntry.status === "old" ? (
              <FriendBadge />
            ) : (
              <FriendToggle
                status={bookEntry.status}
                onChange={handleToggleStatus}
              />
            )}
            <PurposeToggle
              purpose={bookEntry.purpose ?? "active"}
              onChange={handleTogglePurpose}
            />
            <span className="text-xs text-[var(--fg-soft)]">
              已查 {bookEntry.queryCount} 次
            </span>
          </div>
        )}
      </header>

      {/* Origin-form notice — only when the user searched an inflected form
          (e.g. "arousal" → "arouse"). We surface the canonical lemma + its
          part-of-speech + a one-line gloss so the user immediately sees the
          relationship instead of being silently redirected. */}
      {redirected && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-soft)] px-4 py-3 text-sm">
          <p className="text-[var(--fg)]">
            <span className="font-medium">{typed}</span>
            <span className="mx-1 text-[var(--fg-soft)]">的原形是</span>
            <span className="font-medium">{lemma}</span>
            {firstPos && (
              <span className="ml-1 text-[var(--fg-soft)]">— {firstPos}</span>
            )}
            {lemmaSummary && (
              <span className="text-[var(--fg-soft)]">：{lemmaSummary}</span>
            )}
          </p>
        </div>
      )}

      {/* AI-filled card for the derived form itself (e.g. arousal). The
          dictionary doesn't carry an independent entry for it, so this
          panel asks an LLM for pos / IPA / definition / examples that
          actually describe the user's typed word. */}
      {redirected && (
        <DerivedFormPanel
          derived={typed}
          base={lemma}
          baseSense={entry.senses[0]}
          onResolved={handleDerivedResolved}
        />
      )}

      {/* Section divider — when redirected, everything below describes the
          BASE lemma (`arouse`), not the user's typed word. Make that
          relationship explicit instead of letting it look like "arousal"
          itself has 4 verb senses and 6 example sentences. */}
      {redirected && (
        <div className="flex items-center gap-3 pt-2">
          <span className="h-px flex-1 bg-[var(--border)]" aria-hidden />
          <span className="text-xs uppercase tracking-wide text-[var(--fg-soft)]">
            派生关系参考 · {lemma}
          </span>
          <span className="h-px flex-1 bg-[var(--border)]" aria-hidden />
        </div>
      )}

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

      {/* 常用搭配（牛津 <cf-blk> 抽取）—— 方便备考 PTE / 雅思的习惯用法 */}
      {entry.phrases && entry.phrases.length > 0 && (
        <PhrasesSection phrases={entry.phrases} />
      )}

      {/* AI 例句区（Day 4）—— 围绕用户搜的词（typed），不是字典原形。
          这样 arousal 的例句不会跑到 arouse 的缓存键上去。 */}
      <AIExamplesPanel lemma={typed} senses={entry.senses} />

      {/* 笔记区（Day 3a）—— 笔记跟着用户搜的词，与 wordbook 条目的 key 一致。 */}
      <NotesPanel lemma={typed} />
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
/**
 * Two-state pill: 新朋友 / 不收藏.
 *
 * "老朋友" is intentionally NOT one of the options — graduation to that
 * state is owned by the Ebbinghaus review flow (`recordReview` bumping
 * level to 7). Already-graduated words render <FriendBadge /> instead.
 */
function FriendToggle({
  status,
  onChange,
}: {
  status: "new" | "archived";
  onChange: (next: "new" | "archived") => void;
}) {
  const items: Array<{ key: "new" | "archived"; label: string }> = [
    { key: "new", label: "新朋友" },
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

/**
 * Read-only badge shown when a word has already graduated to 老朋友 via
 * the Ebbinghaus flow. We deliberately don't expose a way to demote it
 * here — the only way back is failing future reviews (which the engine
 * handles automatically).
 */
function FriendBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-[var(--accent)] bg-[var(--accent-soft)] px-2.5 py-1 text-xs text-[var(--accent)]"
      title="通过艾宾浩斯打卡毕业"
    >
      <span aria-hidden>✓</span>
      <span>老朋友 · 已掌握</span>
    </span>
  );
}

/**
 * Two-state pill: 听说写 / 阅读.
 *
 * Chooses which review flow this word takes:
 *   - active  (听说写) → 听音拼写 / 同义词选择 + AI 造句批改（默认）。
 *   - passive (阅读)  → 看到自评 “认识 / 不认识”，不需习写。
 * 听说写 / 阅读 二者共享一条艾宾浩斯曲线，只是检验形式不同，
 * 因此在详情页随时可以切换而不影响 level / nextReviewAt。
 */
function PurposeToggle({
  purpose,
  onChange,
}: {
  purpose: WordbookPurpose;
  onChange: (next: WordbookPurpose) => void;
}) {
  const items: Array<{ key: WordbookPurpose; label: string; hint: string }> = [
    { key: "active", label: "听说写", hint: "听音辨词、拼写、造句（完整复习）" },
    { key: "passive", label: "阅读", hint: "只求看到认识，自评认识 / 不认识" },
  ];
  return (
    <div
      className="inline-flex rounded-md border border-[var(--border)] p-0.5"
      role="radiogroup"
      aria-label="复习方式"
    >
      {items.map((it) => {
        const active = it.key === purpose;
        return (
          <button
            key={it.key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(it.key)}
            title={it.hint}
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

// ---------------------------------------------------------------------------

/**
 * <PhrasesSection /> — renders the collocation frames Oxford ships with the
 * entry (extracted by `scripts/parse_mdx.py` from `<cf-blk><cf>~ to sth</cf>`).
 *
 * UX intent
 * ---------
 *  - Show the first 6 phrases by default; expand-on-click for the rest.
 *    Entries like `take` have 20 patterns, but the first few are the ones
 *    a learner actually needs to memorise.
 *  - Each row shows the "filled" form ("prone to sth") as a chunky label
 *    plus the mdx example under it. The example carries the accent —
 *    that's what turns an abstract pattern into something a PTE/IELTS
 *    student can actually recall.
 *  - Provide a small speak button per example so the user can hear the
 *    natural intonation of the phrase in context.
 */
const DEFAULT_VISIBLE = 6;

function PhrasesSection({ phrases }: { phrases: DictPhrase[] }) {
  const [expanded, setExpanded] = useState(false);
  const hasMore = phrases.length > DEFAULT_VISIBLE;
  const visible = expanded ? phrases : phrases.slice(0, DEFAULT_VISIBLE);

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium uppercase tracking-wide text-[var(--accent)]">
        常用搭配
      </h2>
      <ul className="space-y-2">
        {visible.map((p, i) => (
          <li
            key={`${p.pattern}-${i}`}
            className="rounded-lg border border-[var(--border)] p-3"
          >
            <p className="font-medium text-sm">{p.filled}</p>
            {p.example && (
              <div className="mt-1.5 space-y-0.5 border-l border-[var(--border)] pl-3">
                <div className="flex items-start gap-2">
                  <p className="flex-1 text-sm">{p.example.en}</p>
                  <SpeakButton text={p.example.en} variant="us" />
                </div>
                {p.example.cn && (
                  <p className="text-xs text-[var(--fg-soft)]">
                    {p.example.cn}
                  </p>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {hasMore && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-[var(--accent)] hover:underline"
        >
          {expanded
            ? "收起"
            : `展开全部 ${phrases.length} 条搭配 →`}
        </button>
      )}
    </section>
  );
}
