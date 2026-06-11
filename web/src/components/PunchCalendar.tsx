"use client";

/**
 * <PunchCalendar /> — current-month calendar showing punched days + streak.
 *
 * Reads from the local punches store; updates whenever a punch event fires
 * (e.g. user completes /review in a different tab).
 */

import { useEffect, useState } from "react";
import { currentStreak, punchesInMonth } from "@/lib/wordbook/punches";

export default function PunchCalendar() {
  const [today, setToday] = useState<Date | null>(null);
  const [punched, setPunched] = useState<Set<number>>(new Set());
  const [streak, setStreak] = useState(0);

  useEffect(() => {
    function refresh() {
      const now = new Date();
      setToday(now);
      setPunched(punchesInMonth(now.getFullYear(), now.getMonth()));
      setStreak(currentStreak(now));
    }
    refresh();
    window.addEventListener("get:punch-change", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("get:punch-change", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  // Render placeholder shell on first paint (server) so the calendar grid
  // layout doesn't jump when client data lands.
  if (!today) {
    return (
      <div className="rounded-xl border border-[var(--border)] p-4">
        <div className="h-4 w-24 animate-pulse rounded bg-[var(--bg-soft)]" />
        <div className="mt-4 h-40 animate-pulse rounded-md bg-[var(--bg-soft)]" />
      </div>
    );
  }

  const year = today.getFullYear();
  const month = today.getMonth();
  const todayDate = today.getDate();
  const monthLabel = `${year} 年 ${month + 1} 月`;

  const firstDayOfMonth = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<number | null> = [];
  for (let i = 0; i < firstDayOfMonth; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="rounded-xl border border-[var(--border)] p-4">
      <div className="flex items-baseline justify-between">
        <div className="text-base font-medium">{monthLabel}</div>
        <div className="text-xs text-[var(--fg-soft)]">
          连续打卡 {streak} 天
        </div>
      </div>
      <div className="mt-4 grid grid-cols-7 gap-1 text-center text-[11px] text-[var(--fg-soft)]">
        {["日", "一", "二", "三", "四", "五", "六"].map((w) => (
          <div key={w} className="py-1">
            {w}
          </div>
        ))}
        {cells.map((d, i) => {
          if (d === null) {
            return <div key={i} className="aspect-square" />;
          }
          const isPunched = punched.has(d);
          const isToday = d === todayDate;
          return (
            <div
              key={i}
              className={[
                "aspect-square flex items-center justify-center rounded-md text-xs",
                isPunched
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--fg)]",
                isToday && !isPunched ? "ring-1 ring-[var(--accent)]" : "",
              ].join(" ")}
            >
              {d}
            </div>
          );
        })}
      </div>
    </div>
  );
}
