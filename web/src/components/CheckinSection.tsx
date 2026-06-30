"use client";

import Link from "next/link";
import { useEffect, useState, useCallback } from "react";
import { currentStreak, punchesInMonth } from "@/lib/wordbook/punches";
import { listEntries } from "@/lib/wordbook/local";
import { pickDailyQueue } from "@/lib/wordbook/scheduler";

function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function CheckinSection() {
  const [today, setToday] = useState<Date | null>(null);
  // viewMonth 用于支持用户切换查看月份；与"今天"分开存储。
  const [viewMonth, setViewMonth] = useState<{ year: number; month: number } | null>(null);
  const [punched, setPunched] = useState<Set<number>>(new Set());
  const [streak, setStreak] = useState(0);

  const [dueTotal, setDueTotal] = useState(0);
  const [finishedToday, setFinishedToday] = useState(0);

  const refresh = useCallback(() => {
    const now = new Date();
    setToday(now);
    setStreak(currentStreak(now));

    const all = listEntries();
    const todayKey = localDayKey(now);
    const due = pickDailyQueue(all);
    setDueTotal(due.length);
    const finished = all.filter((e) => {
      if (e.level <= 0) return false;
      return localDayKey(new Date(e.lastSeenAt)) === todayKey;
    }).length;
    setFinishedToday(finished);
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener("get:punch-change", refresh);
    window.addEventListener("get:wordbook-change", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("get:punch-change", refresh);
      window.removeEventListener("get:wordbook-change", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refresh]);

  // 初始化 viewMonth 为当前月份
  useEffect(() => {
    if (today && !viewMonth) {
      setViewMonth({ year: today.getFullYear(), month: today.getMonth() });
    }
  }, [today, viewMonth]);

  // 当 viewMonth 或打卡数据变化时，重新加载该月份的打卡情况
  useEffect(() => {
    if (!viewMonth) return;
    setPunched(punchesInMonth(viewMonth.year, viewMonth.month));
    function onPunchChange() {
      if (viewMonth) setPunched(punchesInMonth(viewMonth.year, viewMonth.month));
    }
    window.addEventListener("get:punch-change", onPunchChange);
    return () => {
      window.removeEventListener("get:punch-change", onPunchChange);
    };
  }, [viewMonth]);

  if (!today || !viewMonth) {
    return (
      <div className="rounded-2xl border border-[var(--border)] p-4 h-full">
        <div className="h-4 w-24 animate-pulse rounded bg-[var(--bg-soft)]" />
        <div className="mt-4 h-40 animate-pulse rounded-md bg-[var(--bg-soft)]" />
      </div>
    );
  }

  const { year, month } = viewMonth;
  const isCurrentMonth =
    today.getFullYear() === year && today.getMonth() === month;
  const todayDate = today.getDate();

  const firstDayOfMonth = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<number | null> = [];
  for (let i = 0; i < firstDayOfMonth; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const totalToday = dueTotal + finishedToday;
  const isFinished = totalToday > 0 && dueTotal === 0;
  const hasNothingToReview = totalToday === 0;

  const monthLabel = new Date(year, month, 1).toLocaleString("en-US", {
    month: "long",
  });

  function goPrevMonth() {
    setViewMonth((v) => {
      if (!v) return v;
      const m = v.month - 1;
      return m < 0
        ? { year: v.year - 1, month: 11 }
        : { year: v.year, month: m };
    });
  }

  function goNextMonth() {
    setViewMonth((v) => {
      if (!v) return v;
      const m = v.month + 1;
      return m > 11
        ? { year: v.year + 1, month: 0 }
        : { year: v.year, month: m };
    });
  }

  return (
    <div className="rounded-2xl border border-[var(--border)] overflow-hidden flex flex-col bg-[var(--bg)] shadow-sm h-full">
      {/* Calendar Header - 月份切换 */}
      <div className="px-4 pt-4 pb-2 shrink-0 flex items-center justify-between">
        <button
          type="button"
          onClick={goPrevMonth}
          aria-label="上一月"
          className="w-8 h-8 rounded-full border border-[var(--border)] flex items-center justify-center text-[var(--fg-soft)] hover:text-[var(--fg)] hover:border-[var(--accent)] transition"
        >
          ‹
        </button>
        <div className="text-center">
          <div className="text-base font-semibold tracking-tight">
            {monthLabel} {year}
          </div>
        </div>
        <button
          type="button"
          onClick={goNextMonth}
          aria-label="下一月"
          className="w-8 h-8 rounded-full border border-[var(--border)] flex items-center justify-center text-[var(--fg-soft)] hover:text-[var(--fg)] hover:border-[var(--accent)] transition"
        >
          ›
        </button>
      </div>

      {/* Calendar Grid - 自适应剩余空间 */}
      <div className="px-3 pt-2 pb-2 flex-1 min-h-0 flex flex-col">
        <div className="grid grid-cols-7 gap-0 text-center text-[10px] text-[var(--fg-soft)] mb-1 shrink-0">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((w) => (
            <div key={w} className="py-0.5 font-medium tracking-wider">
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-y-0.5 text-center text-xs flex-1 min-h-0">
          {cells.map((d, i) => {
            if (d === null) {
              return <div key={i} />;
            }
            const isPunched = punched.has(d);
            const isToday = isCurrentMonth && d === todayDate;
            const dayOfWeek = (firstDayOfMonth + d - 1) % 7;
            const prevPunched = punched.has(d - 1) && dayOfWeek !== 0;
            const nextPunched = punched.has(d + 1) && dayOfWeek !== 6;

            return (
              <div key={i} className="relative flex items-center justify-center">
                {/* Connection background */}
                {isPunched && (
                  <div
                    className={`absolute inset-y-1 ${
                      prevPunched && nextPunched
                        ? "inset-x-0"
                        : prevPunched
                        ? "left-0 right-1/2"
                        : nextPunched
                        ? "left-1/2 right-0"
                        : "hidden"
                    } bg-[var(--accent)] opacity-15`}
                  />
                )}
                {/* Circle or Text */}
                <div
                  className={`relative z-10 flex items-center justify-center w-7 h-7 rounded-full mx-auto ${
                    isPunched && (!prevPunched || !nextPunched)
                      ? "bg-[var(--accent)] text-white shadow-sm"
                      : isPunched
                      ? "text-[var(--accent)] font-medium"
                      : isToday
                      ? "ring-1 ring-[var(--accent)] text-[var(--accent)]"
                      : "text-[var(--fg)]"
                  }`}
                >
                  {d}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 今日打卡 - 紧凑单行布局 */}
      <div className="border-t border-[var(--border)] px-4 py-3 bg-[var(--bg-soft)]/30 shrink-0">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-4 min-w-0 flex-1">
            <div className="text-sm font-semibold whitespace-nowrap">今日打卡</div>
            <div className="flex items-baseline gap-1 text-xs text-[var(--fg-soft)] whitespace-nowrap">
              连续 <span className="text-base font-semibold text-[var(--accent)]">{streak}</span> 天
            </div>
            <div className="flex items-baseline gap-1 text-xs text-[var(--fg-soft)] whitespace-nowrap">
              进度 <span className="text-base font-semibold text-[var(--fg)]">{finishedToday}/{totalToday}</span>
            </div>
          </div>

          {hasNothingToReview ? (
            <button
              type="button"
              disabled
              className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--bg)] px-4 py-1.5 text-xs font-medium opacity-50"
            >
              开始复习
            </button>
          ) : (
            <Link
              href="/review"
              className={[
                "shrink-0 rounded-full px-4 py-1.5 text-center text-xs font-medium transition shadow-sm whitespace-nowrap",
                isFinished
                  ? "border border-[var(--border)] bg-[var(--bg)] text-[var(--fg-soft)] hover:border-[var(--accent)]"
                  : "bg-[var(--accent)] text-white hover:opacity-90 hover:shadow",
              ].join(" ")}
            >
              {isFinished ? "今日已完成" : "开始复习"}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
