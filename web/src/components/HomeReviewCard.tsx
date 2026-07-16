"use client";

/**
 * <HomeReviewCard /> — the "今日打卡" card on the home page.
 *
 * Reads the daily queue from the client-side scheduler (which in turn reads
 * from localStorage), so this MUST be a client component. The wrapping page
 * stays server-rendered for everything else.
 *
 * Progress model:
 *   We delegate to `getDailyProgress()` from `lib/wordbook/daily-snapshot`,
 *   which reads today's frozen queue snapshot and reports:
 *     - `total`     how many cards are expected today (Y)
 *     - `finished`  how many of them the user has reviewed today (X)
 *     - `remaining` = total - finished
 *
 *   Sharing this source with <CheckinSection /> means both surfaces show
 *   identical numbers and both automatically honour the user's daily-cap
 *   preference (see lib/wordbook/preferences.ts) via the same snapshot.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getDailyProgress } from "@/lib/wordbook/daily-snapshot";

export default function HomeReviewCard() {
  const [dueTotal, setDueTotal] = useState(0);
  const [finishedToday, setFinishedToday] = useState(0);

  const refresh = useCallback(() => {
    const { total, finished } = getDailyProgress(new Date());
    setDueTotal(Math.max(0, total - finished));
    setFinishedToday(finished);
  }, []);

  useEffect(() => {
    refresh();
    function onChange() {
      refresh();
    }
    window.addEventListener("get:wordbook-change", onChange);
    window.addEventListener("get:daily-snapshot-change", onChange);
    window.addEventListener("get:preferences-change", onChange);
    // Also refresh when the page becomes visible again (user came back from /review).
    document.addEventListener("visibilitychange", onChange);
    return () => {
      window.removeEventListener("get:wordbook-change", onChange);
      window.removeEventListener("get:daily-snapshot-change", onChange);
      window.removeEventListener("get:preferences-change", onChange);
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
