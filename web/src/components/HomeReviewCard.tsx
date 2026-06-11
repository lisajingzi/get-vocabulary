"use client";

/**
 * <HomeReviewCard /> — the "今日打卡" card on the home page.
 *
 * Reads the daily queue from the client-side scheduler (which in turn reads
 * from localStorage), so this MUST be a client component. The wrapping page
 * stays server-rendered for everything else.
 *
 * Two pieces of progress live here:
 *   - `dueTotal`     how many cards the scheduler picked for today
 *   - `finishedToday` how many of them have already been reviewed today
 *
 * The "finished today" derivation is intentionally cheap: we count the
 * wordbook entries whose `lastSeenAt` is on the same local calendar day as
 * `now` AND whose level is greater than 0 (i.e. at least one review has
 * landed since their first lookup). This mirrors what the user sees in the
 * review flow without needing a separate review-log store.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { listEntries } from "@/lib/wordbook/local";
import { pickDailyQueue } from "@/lib/wordbook/scheduler";

function localDayKey(d: Date): string {
  // YYYY-MM-DD in the user's local TZ — matches what the punch-in table
  // will use on Day 7.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function HomeReviewCard() {
  const [dueTotal, setDueTotal] = useState(0);
  const [finishedToday, setFinishedToday] = useState(0);

  const refresh = useCallback(() => {
    const all = listEntries();
    const todayKey = localDayKey(new Date());
    // Today's queue size = items still due RIGHT NOW. As the user finishes
    // them in /review, they get rescheduled into the future and drop out
    // of this list, so dueTotal naturally counts down.
    const due = pickDailyQueue(all);
    setDueTotal(due.length);
    // "已完成" = entries reviewed today (level > 0 implies at least one
    // review attempt has landed; lastSeenAt on today implies it landed
    // on this calendar day in local time).
    const finished = all.filter((e) => {
      if (e.level <= 0) return false;
      return localDayKey(new Date(e.lastSeenAt)) === todayKey;
    }).length;
    setFinishedToday(finished);
  }, []);

  useEffect(() => {
    refresh();
    function onChange() {
      refresh();
    }
    window.addEventListener("get:wordbook-change", onChange);
    // Also refresh when the page becomes visible again (user came back from /review).
    document.addEventListener("visibilitychange", onChange);
    return () => {
      window.removeEventListener("get:wordbook-change", onChange);
      document.removeEventListener("visibilitychange", onChange);
    };
  }, [refresh]);

  const totalToday = dueTotal + finishedToday;
  const isFinished = totalToday > 0 && dueTotal === 0;
  const hasNothingToReview = totalToday === 0;

  return (
    <div className="rounded-xl border border-[var(--border)] p-4 flex flex-col">
      <div className="text-base font-medium">今日打卡</div>
      <div className="mt-3 flex-1">
        {hasNothingToReview ? (
          <p className="text-sm text-[var(--fg-soft)]">
            单词本里还没有需要复习的单词。先去查几个生词吧。
          </p>
        ) : isFinished ? (
          <p className="text-sm text-[var(--fg-soft)]">
            ✅ 今日 {finishedToday} 个单词已完成
          </p>
        ) : (
          <p className="text-sm text-[var(--fg-soft)]">
            进度 {finishedToday} / {totalToday}
          </p>
        )}
      </div>
      {hasNothingToReview ? (
        <button
          type="button"
          disabled
          className="mt-4 w-full rounded-md border border-[var(--border)] px-3 py-2 text-sm opacity-50"
        >
          开始复习
        </button>
      ) : (
        <Link
          href="/review"
          className={[
            "mt-4 w-full rounded-md border px-3 py-2 text-center text-sm transition",
            isFinished
              ? "border-[var(--border)] text-[var(--fg-soft)] hover:border-[var(--accent)]"
              : "border-[var(--accent)] bg-[var(--accent)] text-white hover:opacity-90",
          ].join(" ")}
        >
          {isFinished ? "今日已完成" : "开始复习"}
        </Link>
      )}
    </div>
  );
}
