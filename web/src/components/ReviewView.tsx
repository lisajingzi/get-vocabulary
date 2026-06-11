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
 *   advance(pass) writes recordReview('pass'), bumps level, schedules next due,
 *   then moves to the next queue entry. If the queue is empty we land on
 *   the "done" screen.
 *
 *   advance(fail) only fires when the user couldn't pick the right synonym
 *   (we re-prompt until they get it right, per spec). The "lose a level"
 *   event happens once per item, regardless of how many wrong picks they
 *   made on the way to the right answer — that matches the user's brief:
 *   "失败一次退回一级".
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  listEntries,
  recordReview,
  type WordbookEntry,
} from "@/lib/wordbook/local";
import { pickDailyQueue } from "@/lib/wordbook/scheduler";
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
  | {
      kind: "compose";
      target: string;
      prompt: SynonymQuestion["prompt"];
      failedOnce: boolean;
    }
  | { kind: "done"; finished: number; total: number };

interface CorrectionResult {
  ok: boolean;
  reason: string;
  segments: Array<{ text: string; wrong?: boolean; fix?: string }>;
  provider: "deepseek" | "mock";
}

export default function ReviewView() {
  const [queue, setQueue] = useState<WordbookEntry[]>([]);
  const [cursor, setCursor] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  // ----- bootstrap: build today's queue once on mount ----------------------
  useEffect(() => {
    const all = listEntries();
    const due = pickDailyQueue(all);
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
      // Fallback: skip directly to the compose phase using whatever sense
      // info we can read off the first sense; the user still gets value.
      setPhase({
        kind: "compose",
        target: lemma,
        prompt: { def: undefined, chn: undefined, pos: undefined },
        failedOnce,
      });
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
    return <ReviewSkeleton />;
  }
  if (phase.kind === "empty") {
    return <EmptyState />;
  }
  if (phase.kind === "done") {
    return <DoneState finished={phase.finished} total={phase.total} />;
  }

  return (
    <div className="space-y-4">
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

  // Reset picked state whenever a new question arrives.
  useEffect(() => {
    setPicked(null);
    setFeedback(null);
  }, [q.target]);

  function handlePick(i: number) {
    if (feedback === "right") return;
    setPicked(i);
    if (i === q.answerIndex) {
      setFeedback("right");
      // brief celebratory pause, then advance
      setTimeout(onCorrect, 450);
    } else {
      setFeedback("wrong");
      onWrong();
    }
  }

  return (
    <section className="space-y-4 rounded-xl border border-[var(--border)] p-4">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-semibold tracking-tight">
            <span aria-hidden>＿＿＿＿</span>
          </h2>
          <SpeakButton text={q.target} variant="us" />
        </div>
        {q.prompt.pos && (
          <span className="inline-block rounded bg-[var(--bg-soft)] px-1.5 py-0.5 text-[11px] text-[var(--fg-soft)]">
            {q.prompt.pos}
          </span>
        )}
        {q.prompt.def && (
          <p className="text-sm text-[var(--fg)]">{q.prompt.def}</p>
        )}
        {q.prompt.chn && (
          <p className="text-sm text-[var(--fg-soft)]">{q.prompt.chn}</p>
        )}
        <p className="pt-2 text-xs text-[var(--fg-soft)]">
          请选择最接近的近义词：
        </p>
      </header>

      <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {q.choices.map((lemma, i) => {
          const isPicked = picked === i;
          const isAnswer = i === q.answerIndex;
          let cls =
            "rounded-lg border border-[var(--border)] px-3 py-2 text-left text-sm transition hover:border-[var(--accent)]";
          if (feedback && isAnswer) {
            cls += " border-[var(--accent)] bg-[var(--accent-soft)]";
          } else if (feedback === "wrong" && isPicked) {
            cls += " border-red-400 text-red-500";
          }
          return (
            <li key={lemma}>
              <button
                type="button"
                onClick={() => handlePick(i)}
                disabled={feedback === "right"}
                className={cls}
              >
                {lemma}
              </button>
            </li>
          );
        })}
      </ul>

      {feedback === "wrong" && (
        <p className="text-xs text-red-500">不对，再试一次。</p>
      )}
      {feedback === "right" && (
        <p className="text-xs text-[var(--accent)]">
          答对了{failedOnce ? "（本题之前错过一次，本次将算作失败）" : ""}！
        </p>
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
          <h2 className="text-xl font-semibold">{target}</h2>
          <SpeakButton text={target} variant="us" />
        </div>
        {prompt.chn && (
          <p className="text-sm text-[var(--fg-soft)]">{prompt.chn}</p>
        )}
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

      {result && (
        <div className="space-y-2 rounded-lg bg-[var(--bg-soft)] p-3 text-sm">
          <CorrectedSentence segments={result.segments} />
          <p className="text-xs text-[var(--fg-soft)]">{result.reason}</p>
        </div>
      )}

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
