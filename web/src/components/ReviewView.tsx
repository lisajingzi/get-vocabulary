"use client";

/**
 * <ReviewView /> — the daily Ebbinghaus review flow.
 *
 * State machine per item:
 *
 *   loading   →   quiz   ─pass─→   compose   ─grade ok─→   advance(pass)
 *                  │                                   ╲
 *                  └─fail (retry until correct)         ─grade not ok─→ stays in compose
 *
 *              or
 *
 *   loading   →   spell  ─pass─→   compose   ─…
 *                  │
 *                  └─fail (retry until correct, marks failedOnce)
 *
 * The `spell` phase kicks in when the offline WordNet table has no usable
 * synonym for the target lemma — rather than showing dubious "synonyms"
 * we test recall via spelling. The user hears the word, types it, and
 * we advance on an exact match.
 *
 *   advance(pass) writes recordReview('pass'), bumps level, schedules next due,
 *   then moves to the next queue entry. If the queue is empty we land on
 *   the "done" screen.
 *
 *   advance(fail) only fires when the user couldn't pick the right synonym
 *   (or spell the target). The "lose a level" event happens once per item,
 *   regardless of how many wrong attempts they made — that matches the
 *   user's brief: "失败一次退回一级".
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  listEntries,
  recordReview,
  type WordbookEntry,
} from "@/lib/wordbook/local";
import { MAX_LEVEL } from "@/lib/wordbook/scheduler";
import { getTodaySnapshot } from "@/lib/wordbook/daily-snapshot";
import { recordPunchToday } from "@/lib/wordbook/punches";
import {
  buildSynonymQuestion,
  type SynonymQuestion,
} from "@/lib/wordbook/synonyms";
import SpeakButton from "@/components/SpeakButton";

type Phase =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "quiz"; q: SynonymQuestion; failedOnce: boolean }
  | { kind: "spell"; target: string; failedOnce: boolean }
  | {
      kind: "compose";
      target: string;
      prompt: SynonymQuestion["prompt"];
      failedOnce: boolean;
    }
  | { kind: "done"; finished: number; total: number };

interface CorrectionResult {
  ok: boolean;
  recommended: string;
  recommendedAlt?: string;
  segments: Array<{ text: string; wrong?: boolean; fix?: string }>;
  diagnosis: string[];
  /**
   * Track-B style suggestions (NOT errors). These are idiomatic upgrades
   * offered even when the sentence is examiner-correct, and they never
   * flip `ok` to false. Rendered in a separate, visually neutral zone
   * so the learner never confuses "more natural" with "wrong".
   */
  suggestions?: Array<{ text: string; reason: string }>;
  distinction?: string;
  ielts?: string;
  provider: "deepseek" | "mock";
}

export default function ReviewView() {
  const [queue, setQueue] = useState<WordbookEntry[]>([]);
  const [cursor, setCursor] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  // ----- bootstrap: build today's queue once on mount ----------------------
  useEffect(() => {
    // The home page froze a "today's queue" snapshot the first time it
    // rendered (or here, whichever happened first). We rebuild the queue
    // by intersecting that snapshot with the current entry state so that:
    //   - already-reviewed-today cards are skipped
    //   - cards moved to 老朋友 / archived during the day are dropped
    //   - new lookups added later today are NOT reviewed today (→ tomorrow)
    function localDayKey(d: Date): string {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }
    const now = new Date();
    const todayKey = localDayKey(now);
    const snapshot = getTodaySnapshot(now);
    const byLemma = new Map<string, WordbookEntry>();
    for (const e of listEntries()) byLemma.set(e.lemma, e);
    const due: WordbookEntry[] = [];
    snapshot.forEach((lemma) => {
      const e = byLemma.get(lemma);
      if (!e) return;
      if (e.status !== "new") return;
      if (e.level >= MAX_LEVEL) return;
      if (
        e.lastReviewedAt &&
        localDayKey(new Date(e.lastReviewedAt)) === todayKey
      ) {
        return;
      }
      due.push(e);
    });
    // Stable order: oldest lastSeenAt first, mirrors pickDailyQueue's order
    // so the user gets the same sequence whether they entered from snapshot
    // or freshly computed queue.
    due.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? -1 : 1));
    setQueue(due);
    setCursor(0);
    if (due.length === 0) {
      setPhase({ kind: "empty" });
    }
  }, []);

  // ----- whenever cursor moves to a new in-bounds item, build its quiz ----
  const buildQuestion = useCallback(async (lemma: string, failedOnce: boolean) => {
    setPhase({ kind: "loading" });
    const q = await buildSynonymQuestion(lemma);
    if (!q) {
      // Offline synonym table has nothing usable for this lemma — typically
      // a concrete noun ("quarry", "anvil") or a rare adjective. Instead
      // of teaching the user a fake "synonym", we test recall via spelling.
      setPhase({ kind: "spell", target: lemma, failedOnce });
      return;
    }
    setPhase({ kind: "quiz", q, failedOnce });
  }, []);

  useEffect(() => {
    if (queue.length === 0) return;
    if (cursor >= queue.length) {
      // Queue cleared — record the punch-in for today (idempotent).
      recordPunchToday();
      setPhase({ kind: "done", finished: queue.length, total: queue.length });
      return;
    }
    const item = queue[cursor];
    void buildQuestion(item.lemma, false);
  }, [cursor, queue, buildQuestion]);

  // ----- advance helper: persist outcome + step the cursor ----------------
  const advance = useCallback(
    (result: "pass" | "fail") => {
      if (queue.length === 0) return;
      const item = queue[cursor];
      if (item) recordReview(item.lemma, result);
      setCursor((c) => c + 1);
    },
    [queue, cursor],
  );

  // ---- render ------------------------------------------------------------

  if (phase.kind === "loading") {
    return (
      <div className="space-y-4">
        <ReviewTopBar />
        <ReviewSkeleton />
      </div>
    );
  }
  if (phase.kind === "empty") {
    return (
      <div className="space-y-4">
        <ReviewTopBar />
        <EmptyState />
      </div>
    );
  }
  if (phase.kind === "done") {
    return (
      <div className="space-y-4">
        <ReviewTopBar />
        <DoneState finished={phase.finished} total={phase.total} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ReviewTopBar />
      <ProgressBar current={cursor + 1} total={queue.length} />
      {phase.kind === "quiz" && (
        <QuizPanel
          q={phase.q}
          failedOnce={phase.failedOnce}
          onCorrect={() =>
            setPhase({
              kind: "compose",
              target: phase.q.target,
              prompt: phase.q.prompt,
              failedOnce: phase.failedOnce,
            })
          }
          onWrong={() =>
            setPhase({ kind: "quiz", q: phase.q, failedOnce: true })
          }
        />
      )}
      {phase.kind === "spell" && (
        <SpellPanel
          target={phase.target}
          failedOnce={phase.failedOnce}
          onCorrect={() =>
            setPhase({
              kind: "compose",
              target: phase.target,
              // We deliberately don't pass a Chinese gloss into the compose
              // step: showing it turns composing-with-the-word into a
              // translation exercise. ComposePanel already handles this.
              prompt: { def: undefined, chn: undefined, pos: undefined },
              failedOnce: phase.failedOnce,
            })
          }
          onWrong={() =>
            setPhase({
              kind: "spell",
              target: phase.target,
              failedOnce: true,
            })
          }
        />
      )}
      {phase.kind === "compose" && (
        <ComposePanel
          target={phase.target}
          prompt={phase.prompt}
          failedOnce={phase.failedOnce}
          onAccepted={() => advance(phase.failedOnce ? "fail" : "pass")}
        />
      )}
    </div>
  );
}

// ===========================================================================
// Sub-components
// ===========================================================================

function ReviewTopBar() {
  return (
    <div className="flex justify-start">
      <Link
        href="/"
        className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs text-[var(--fg-soft)] transition hover:border-[var(--accent)] hover:text-[var(--fg)]"
      >
        <span aria-hidden>←</span>
        返回首页
      </Link>
    </div>
  );
}

function ProgressBar({ current, total }: { current: number; total: number }) {
  const pct = Math.min(100, Math.round(((current - 1) / total) * 100));
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs text-[var(--fg-soft)]">
        <span>
          第 {current} / {total} 个
        </span>
        <span>剩 {Math.max(0, total - current + 1)}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-[var(--bg-soft)]">
        <div
          className="h-full bg-[var(--accent)] transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Spelling-recall panel. Rendered when the offline synonym table has no
 * usable entry for the target lemma, so the near-synonym multiple-choice
 * quiz can't be constructed. The user hears the word (via <SpeakButton />)
 * and types it back.
 *
 * Design decisions:
 *   - The prompt intentionally does NOT display the Chinese gloss (per
 *     spec: "拼写题的题干不要显示中文释义"). The audio is the only cue,
 *     matching how the user actually needs to recall the word in the wild.
 *   - Comparison is case-insensitive and whitespace-trimmed, but otherwise
 *     exact — no fuzzy match, no first-letter hints. Getting close doesn't
 *     count. This is a recall test.
 *   - On wrong answers we surface the correct spelling AND the target's
 *     Chinese gloss (safe now — the recall attempt is over) so the user
 *     still learns something before advancing.
 *   - The compose step that follows does the real "prove you understand
 *     the meaning" work, so a wrong spelling here just means they see the
 *     word first and then compose with it.
 */
function SpellPanel({
  target,
  failedOnce,
  onCorrect,
  onWrong,
}: {
  target: string;
  failedOnce: boolean;
  onCorrect: () => void;
  onWrong: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [feedback, setFeedback] = useState<
    "right" | "wrong" | "revealed" | null
  >(null);
  const [gloss, setGloss] = useState<{
    pos?: string;
    def?: string;
    chn?: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset every time the target changes (retry after wrong answer, or the
  // outer queue moves us to a new lemma).
  useEffect(() => {
    setDraft("");
    setFeedback(null);
    setGloss(null);
    inputRef.current?.focus();
  }, [target]);

  // Lazy-load the gloss for the "you got it wrong" and "you got it right"
  // reveal panels. Cheap: `lookup` is memoised at the shard level.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { lookup } = await import("@/lib/dict");
      const got = await lookup(target);
      if (cancelled) return;
      const s = got?.entry.senses?.[0];
      setGloss(s ? { pos: s.pos, def: s.def, chn: s.chn } : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  function submit() {
    const guess = draft.trim().toLowerCase();
    if (!guess) return;
    if (guess === target.toLowerCase()) {
      setFeedback("right");
    } else {
      setFeedback("wrong");
      onWrong();
    }
  }

  function giveUp() {
    // "我不会" — user surrenders. Book it as a wrong answer (same effect as
    // typing the wrong spelling) and reveal the correct word + gloss. No
    // retry offered; the only forward path is "下一步" into compose.
    setFeedback("revealed");
    onWrong();
  }

  function retry() {
    setDraft("");
    setFeedback(null);
    inputRef.current?.focus();
  }

  return (
    <section className="space-y-4 rounded-xl border border-[var(--border)] p-4">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-semibold tracking-tight">
            <span aria-hidden>＿＿＿＿</span>
          </h2>
          <SpeakButton text={target} variant="us" />
        </div>
        <p className="pt-2 text-xs text-[var(--fg-soft)]">
          请听音后拼写出这个单词：
        </p>
      </header>

      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (feedback === "right" || feedback === "revealed") onCorrect();
              else if (feedback === "wrong") retry();
              else submit();
            }
          }}
          disabled={feedback === "right" || feedback === "revealed"}
          placeholder="在此输入…"
          className="flex-1 rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-base outline-none focus:border-[var(--accent)] disabled:opacity-60"
        />
        {feedback === "right" || feedback === "revealed" ? (
          <button
            type="button"
            onClick={onCorrect}
            className="rounded-md border border-[var(--accent)] bg-[var(--accent)] px-3 py-2 text-xs text-white transition hover:opacity-90"
          >
            下一步 →
          </button>
        ) : feedback === "wrong" ? (
          <button
            type="button"
            onClick={retry}
            className="rounded-md border border-[var(--border)] px-3 py-2 text-xs transition hover:border-[var(--accent)]"
          >
            再试一次
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim()}
              className="rounded-md border border-[var(--border)] px-3 py-2 text-xs transition hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              提交
            </button>
            <button
              type="button"
              onClick={giveUp}
              title="放弃本题，直接查看答案（本题会记为失败）"
              className="rounded-md border border-[var(--border)] px-3 py-2 text-xs text-[var(--fg-soft)] transition hover:border-red-400 hover:text-red-500"
            >
              我不会
            </button>
          </>
        )}
      </div>

      {feedback === "wrong" && (
        <div className="space-y-1.5 rounded-lg border border-red-200 bg-red-50/60 p-3 text-sm dark:border-red-900/40 dark:bg-red-950/20">
          <p className="text-xs font-medium text-red-500">拼写不对，再试一次。</p>
          <p className="text-xs text-[var(--fg-soft)]">
            提示：仔细再听一遍读音。
          </p>
        </div>
      )}

      {feedback === "revealed" && (
        <div className="space-y-2 rounded-lg border border-red-200 bg-red-50/60 p-3 text-sm dark:border-red-900/40 dark:bg-red-950/20">
          <p className="text-xs font-medium text-red-500">
            本题记为失败。正确答案：
          </p>
          <div className="space-y-0.5">
            <div className="flex items-baseline gap-2">
              <span className="text-base font-semibold">{target}</span>
              {gloss?.pos && (
                <span className="text-[10px] text-[var(--fg-soft)]">
                  ({gloss.pos})
                </span>
              )}
            </div>
            {gloss?.def && (
              <p className="text-xs text-[var(--fg)]">{gloss.def}</p>
            )}
            {gloss?.chn && (
              <p className="text-xs text-[var(--fg-soft)]">{gloss.chn}</p>
            )}
          </div>
        </div>
      )}

      {feedback === "right" && (
        <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--bg-soft)]/50 p-3 text-sm">
          <p className="text-xs font-medium text-[var(--accent)]">
            拼写正确
            {failedOnce ? "（本题之前错过一次，本次将算作失败）" : ""}！
          </p>
          <div className="space-y-0.5">
            <div className="flex items-baseline gap-2">
              <span className="text-base font-semibold">{target}</span>
              {gloss?.pos && (
                <span className="text-[10px] text-[var(--fg-soft)]">
                  ({gloss.pos})
                </span>
              )}
            </div>
            {gloss?.def && (
              <p className="text-xs text-[var(--fg)]">{gloss.def}</p>
            )}
            {gloss?.chn && (
              <p className="text-xs text-[var(--fg-soft)]">{gloss.chn}</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function QuizPanel({
  q,
  failedOnce,
  onCorrect,
  onWrong,
}: {
  q: SynonymQuestion;
  failedOnce: boolean;
  onCorrect: () => void;
  onWrong: () => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<"right" | "wrong" | null>(null);
  // Track every wrong index so already-tried distractors visibly stay marked
  // while the user keeps trying. We don't reveal the correct answer though.
  const [wrongPicks, setWrongPicks] = useState<Set<number>>(new Set());

  // Reset state whenever a new question arrives.
  useEffect(() => {
    setPicked(null);
    setFeedback(null);
    setWrongPicks(new Set());
  }, [q.target]);

  function handlePick(i: number) {
    if (feedback === "right") return;
    if (wrongPicks.has(i)) return; // already known wrong, ignore
    setPicked(i);
    if (i === q.answerIndex) {
      setFeedback("right");
      // No auto-advance: the user reviews the explanation panel and clicks
      // "下一题" themselves.
    } else {
      setFeedback("wrong");
      setWrongPicks((s) => new Set(s).add(i));
      onWrong();
    }
  }

  const wrongLemma =
    feedback === "wrong" && picked !== null ? q.choices[picked] : null;
  const wrongGloss = wrongLemma ? q.glossMap[wrongLemma] : undefined;

  const correctLemma = q.choices[q.answerIndex];
  const correctGloss = q.glossMap[correctLemma];

  return (
    <section className="space-y-4 rounded-xl border border-[var(--border)] p-4">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-semibold tracking-tight">
            <span aria-hidden>＿＿＿＿</span>
          </h2>
          {/* Always-on speak button: the user explicitly asked for this so
              they can identify which word is being tested. Yes, this is
              technically a hint — they can recognise the word by sound —
              but the synonym selection still requires knowing the meaning,
              not just the spelling. */}
          <SpeakButton text={q.target} variant="us" />
        </div>
        {q.prompt.pos && (
          <span className="inline-block rounded bg-[var(--bg-soft)] px-1.5 py-0.5 text-[11px] text-[var(--fg-soft)]">
            {q.prompt.pos}
          </span>
        )}
        <p className="pt-2 text-xs text-[var(--fg-soft)]">
          请选择最接近的近义词：
        </p>
      </header>

      <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {q.choices.map((lemma, i) => {
          const isPicked = picked === i;
          const isAnswer = i === q.answerIndex;
          const isKnownWrong = wrongPicks.has(i);
          let cls =
            "rounded-lg border border-[var(--border)] px-3 py-2 text-left text-sm transition hover:border-[var(--accent)] disabled:cursor-not-allowed";
          // Only mark the correct answer AFTER the user has chosen it.
          // No more "color reveal" while they're still guessing.
          if (feedback === "right" && isAnswer) {
            cls += " border-[var(--accent)] bg-[var(--accent-soft)]";
          } else if (isKnownWrong) {
            cls += " border-red-300 text-red-400 line-through opacity-60";
          } else if (feedback === "wrong" && isPicked) {
            cls += " border-red-400 text-red-500";
          }
          return (
            <li key={lemma}>
              <button
                type="button"
                onClick={() => handlePick(i)}
                disabled={feedback === "right" || isKnownWrong}
                className={cls}
              >
                {lemma}
              </button>
            </li>
          );
        })}
      </ul>

      {feedback === "wrong" && (
        <div className="space-y-1.5 rounded-lg border border-red-200 bg-red-50/60 p-3 text-sm dark:border-red-900/40 dark:bg-red-950/20">
          <p className="text-xs font-medium text-red-500">不对，再试一次。</p>
          {wrongLemma && (
            <p className="text-xs leading-relaxed text-[var(--fg-soft)]">
              <span className="font-semibold text-[var(--fg)]">
                {wrongLemma}
              </span>
              {wrongGloss?.pos && (
                <span className="ml-1 text-[10px] opacity-70">
                  ({wrongGloss.pos})
                </span>
              )}
              {wrongGloss?.chn && (
                <span className="ml-2">{wrongGloss.chn}</span>
              )}
            </p>
          )}
        </div>
      )}

      {feedback === "right" && (
        <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--bg-soft)]/50 p-3 text-sm">
          <p className="text-xs font-medium text-[var(--accent)]">
            答对了
            {failedOnce ? "（本题之前错过一次，本次将算作失败）" : ""}！
          </p>

          {/* Correct synonym's gloss */}
          <div className="space-y-0.5">
            <div className="flex items-baseline gap-2">
              <span className="text-base font-semibold">{correctLemma}</span>
              {correctGloss?.pos && (
                <span className="text-[10px] text-[var(--fg-soft)]">
                  ({correctGloss.pos})
                </span>
              )}
            </div>
            {correctGloss?.def && (
              <p className="text-xs text-[var(--fg)]">{correctGloss.def}</p>
            )}
            {correctGloss?.chn && (
              <p className="text-xs text-[var(--fg-soft)]">
                {correctGloss.chn}
              </p>
            )}
          </div>

          {/* Target word's own gloss — now safe to reveal */}
          <div className="space-y-0.5 border-t border-[var(--border)]/60 pt-2">
            <div className="flex items-baseline gap-2">
              <span className="text-xs uppercase tracking-wider text-[var(--fg-soft)]">
                本题单词
              </span>
              <span className="text-base font-semibold">{q.target}</span>
              {q.prompt.pos && (
                <span className="text-[10px] text-[var(--fg-soft)]">
                  ({q.prompt.pos})
                </span>
              )}
            </div>
            {q.prompt.def && (
              <p className="text-xs text-[var(--fg)]">{q.prompt.def}</p>
            )}
            {q.prompt.chn && (
              <p className="text-xs text-[var(--fg-soft)]">{q.prompt.chn}</p>
            )}
          </div>

          {/* Quick "why these are similar" hint based on overlapping CN tokens. */}
          {q.sharedTokens.length > 0 && (
            <p className="text-[11px] leading-relaxed text-[var(--fg-soft)]">
              共同语义：
              {q.sharedTokens.map((t, i) => (
                <span
                  key={t}
                  className="ml-1 rounded bg-[var(--bg)] px-1.5 py-0.5 text-[var(--fg)]"
                >
                  {t}
                  {i < q.sharedTokens.length - 1 ? "" : ""}
                </span>
              ))}
              <span className="ml-1">
                。具体使用语境上仍有差异，可结合各自释义体会。
              </span>
            </p>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={onCorrect}
              className="rounded-md border border-[var(--accent)] bg-[var(--accent)] px-3 py-1.5 text-xs text-white transition hover:opacity-90"
            >
              下一步 →
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function ComposePanel({
  target,
  prompt,
  failedOnce,
  onAccepted,
}: {
  target: string;
  prompt: SynonymQuestion["prompt"];
  failedOnce: boolean;
  onAccepted: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CorrectionResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft("");
    setResult(null);
    setErr(null);
    taRef.current?.focus();
  }, [target]);

  async function submit() {
    const sentence = draft.trim();
    if (!sentence) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/ai/correct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lemma: target,
          sentence,
          sense: { def: prompt.def, chn: prompt.chn, pos: prompt.pos },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as CorrectionResult;
      setResult(data);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function handleNext() {
    onAccepted();
  }

  return (
    <section className="space-y-3 rounded-xl border border-[var(--border)] p-4">
      <header className="space-y-1">
        <div className="flex items-baseline gap-2">
          <Link
            href={`/word/${encodeURIComponent(target)}?from=review`}
            target="_blank"
            rel="noopener"
            className="text-xl font-semibold underline decoration-transparent underline-offset-4 transition hover:decoration-[var(--accent)] hover:text-[var(--accent)]"
            title="在新标签页查看单词详情（保留造句进度）"
          >
            {target}
          </Link>
          <SpeakButton text={target} variant="us" />
        </div>
        {/* Intentionally NOT rendering prompt.chn / prompt.def here:
            the compose step is supposed to test whether the user actually
            internalised the meaning, so we hide the gloss to avoid making
            it a translation exercise. The synonym-quiz step above already
            unfolded the full explanation, so the user has had their
            chance to study the meaning before reaching this screen. */}
        <p className="pt-1 text-xs text-[var(--fg-soft)]">
          请用 <span className="font-medium text-[var(--fg)]">{target}</span>{" "}
          造一个英文句子：
        </p>
      </header>

      <textarea
        ref={taRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        placeholder={`例：They had to ${target} the project after only three weeks.`}
        className="w-full resize-none rounded-md border border-[var(--border)] bg-transparent p-2 text-sm outline-none focus:border-[var(--accent)]"
        disabled={busy || result?.ok === true}
      />

      {result && <CoachFeedback result={result} original={draft.trim()} />}

      {err && <p className="text-xs text-red-500">批改失败：{err}</p>}

      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-[var(--fg-soft)]">
          {failedOnce
            ? "近义词题之前答错，本题完成后会回退一级。"
            : "答对一次即可通过本题。"}
        </p>
        {result?.ok ? (
          <button
            type="button"
            onClick={handleNext}
            className="rounded-md border border-[var(--accent)] bg-[var(--accent)] px-3 py-1.5 text-xs text-white"
          >
            下一题 →
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={busy || !draft.trim()}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs transition hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "批改中…" : result ? "再改一次" : "提交批改"}
          </button>
        )}
      </div>
    </section>
  );
}

function CorrectedSentence({
  segments,
}: {
  segments: Array<{ text: string; wrong?: boolean; fix?: string }>;
}) {
  return (
    <p className="leading-relaxed">
      {segments.map((s, i) =>
        s.wrong ? (
          <span key={i}>
            <span className="text-red-500 line-through">{s.text}</span>
            {s.fix && (
              <span className="ml-1 text-[var(--accent)]">{s.fix}</span>
            )}{" "}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </p>
  );
}

/**
 * Coach-style feedback card. Renders four optional zones:
 *   1. Verdict line + diff over the learner's original sentence.
 *   2. Recommended native rewrite(s).
 *   3. Diagnosis bullets + optional confusable-word distinction.
 *   4. IELTS-speaking sample sentence.
 *
 * The card adapts its accent colour to whether the verdict is `good`
 * (= ok=true) or `needs_work`. The intent is: even when the original is
 * already correct, the user still gets a small upgrade suggestion, so the
 * card always has *something* to teach.
 */
function CoachFeedback({
  result,
  original,
}: {
  result: CorrectionResult;
  original: string;
}) {
  const isGood = result.ok;
  const showDiff =
    !isGood && result.segments.some((s) => s.wrong);
  const showRecommended =
    result.recommended && result.recommended.trim() !== original.trim();

  return (
    <div
      className={[
        "space-y-3 rounded-lg border p-3 text-sm",
        isGood
          ? "border-[var(--accent)]/40 bg-[var(--accent-soft)]/40"
          : "border-amber-300/60 bg-amber-50/50 dark:border-amber-700/40 dark:bg-amber-950/20",
      ].join(" ")}
    >
      {/* 1. Verdict + diff (or just the original when good) */}
      <div className="space-y-1">
        <p
          className={[
            "text-[11px] font-semibold uppercase tracking-wider",
            isGood ? "text-[var(--accent)]" : "text-amber-600 dark:text-amber-400",
          ].join(" ")}
        >
          {isGood ? "✓ 句子可用" : "需要打磨"}
        </p>
        {showDiff ? (
          <CorrectedSentence segments={result.segments} />
        ) : (
          <p className="leading-relaxed text-[var(--fg-soft)]">{original}</p>
        )}
      </div>

      {/* 2. Recommended rewrite(s) */}
      {showRecommended && (
        <div className="space-y-1 border-t border-[var(--border)]/60 pt-2">
          <p className="text-[11px] font-medium text-[var(--fg-soft)]">
            {isGood ? "更地道的说法" : "推荐表达"}
          </p>
          <p className="font-medium leading-relaxed text-[var(--fg)]">
            {result.recommended}
          </p>
          {result.recommendedAlt && (
            <p className="leading-relaxed text-[var(--fg-soft)]">
              <span className="mr-1 text-[10px] uppercase tracking-wider opacity-70">
                or
              </span>
              {result.recommendedAlt}
            </p>
          )}
        </div>
      )}

      {/* 3. Diagnosis + distinction (Track-A: real errors only) */}
      {(result.diagnosis.length > 0 || result.distinction) && (
        <div className="space-y-1 border-t border-[var(--border)]/60 pt-2">
          <p className="text-[11px] font-medium text-[var(--fg-soft)]">
            为什么这样改
          </p>
          <ul className="space-y-1 text-xs leading-relaxed text-[var(--fg)]">
            {result.diagnosis.map((d, i) => (
              <li key={i} className="flex gap-1.5">
                <span className="text-[var(--fg-soft)]">·</span>
                <span dangerouslySetInnerHTML={{ __html: renderInlineCode(d) }} />
              </li>
            ))}
            {result.distinction && (
              <li className="flex gap-1.5">
                <span className="text-[var(--fg-soft)]">·</span>
                <span
                  dangerouslySetInnerHTML={{
                    __html: renderInlineCode(result.distinction),
                  }}
                />
              </li>
            )}
          </ul>
        </div>
      )}

      {/* 3b. Track-B style suggestions — visually distinct from errors:
              neutral slate palette, explicit "不算错" label. Rendered
              regardless of ok, because idiomatic upgrades exist on top
              of a grammatically fine sentence too. */}
      {result.suggestions && result.suggestions.length > 0 && (
        <div className="space-y-1.5 border-t border-[var(--border)]/60 pt-2">
          <p className="text-[11px] font-medium text-[var(--fg-soft)]">
            更地道的说法
            <span className="ml-1.5 rounded-sm bg-[var(--fg-soft)]/10 px-1 py-0.5 text-[9px] font-normal uppercase tracking-wider text-[var(--fg-soft)]">
              不算错
            </span>
          </p>
          <ul className="space-y-1.5">
            {result.suggestions.map((s, i) => (
              <li key={i} className="space-y-0.5">
                <p className="leading-relaxed text-[var(--fg)]">{s.text}</p>
                <p
                  className="pl-2 text-xs leading-relaxed text-[var(--fg-soft)]"
                  dangerouslySetInnerHTML={{ __html: renderInlineCode(s.reason) }}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 4. IELTS-speaking sample */}
      {result.ielts && (
        <div className="space-y-1 border-t border-[var(--border)]/60 pt-2">
          <p className="text-[11px] font-medium text-[var(--fg-soft)]">
            雅思口语可这样说
          </p>
          <p className="italic leading-relaxed text-[var(--fg)]">
            “{result.ielts}”
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Render markdown-style backticks (`word`) as inline <code>. This is the
 * tiniest possible markdown subset — we only support backticks because the
 * coach prompt explicitly emits them around English words inside Chinese
 * explanations, and we want those words to stand out visually.
 *
 * Input is sanitised by HTML-escaping the surrounding text first, so it is
 * safe to feed into dangerouslySetInnerHTML.
 */
function renderInlineCode(s: string): string {
  const escape = (t: string) =>
    t
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  // Split on `…` while keeping the matched groups.
  const parts = s.split(/`([^`]+)`/g);
  return parts
    .map((p, i) =>
      i % 2 === 1
        ? `<code class="rounded bg-[var(--bg)] px-1 py-0.5 font-mono text-[0.85em] text-[var(--fg)]">${escape(p)}</code>`
        : escape(p),
    )
    .join("");
}

function ReviewSkeleton() {
  return (
    <div className="space-y-3">
      <div className="h-4 w-32 animate-pulse rounded bg-[var(--bg-soft)]" />
      <div className="h-32 animate-pulse rounded-xl bg-[var(--bg-soft)]" />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="space-y-3 rounded-xl border border-dashed border-[var(--border)] p-6 text-center">
      <p className="text-base font-medium">今天没有需要复习的单词。</p>
      <p className="text-sm text-[var(--fg-soft)]">
        先去
        <Link href="/" className="mx-1 text-[var(--accent)] hover:underline">
          首页
        </Link>
        查几个新词吧；它们会按艾宾浩斯曲线安排复习。
      </p>
    </div>
  );
}

function DoneState({ finished, total }: { finished: number; total: number }) {
  return (
    <div className="space-y-3 rounded-xl border border-[var(--border)] p-6 text-center">
      <p className="text-2xl">🎉</p>
      <p className="text-base font-medium">
        今日 {finished} / {total} 个单词已完成
      </p>
      <p className="text-sm text-[var(--fg-soft)]">
        别忘了
        <Link href="/" className="mx-1 text-[var(--accent)] hover:underline">
          回首页
        </Link>
        看看打卡日历。
      </p>
    </div>
  );
}
