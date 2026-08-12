"use client";

import Link from "next/link";
import { useEffect, useState, useCallback } from "react";
import { currentStreak, punchesInMonth } from "@/lib/wordbook/punches";
import { readReviewLog } from "@/lib/wordbook/review-log";

export default function CheckinSection() {
  const [today, setToday] = useState<Date | null>(null);
  const [viewMonth, setViewMonth] = useState<{ year: number; month: number } | null>(null);
  const [punched, setPunched] = useState<Set<number>>(new Set());
  const [streak, setStreak] = useState(0);
  const [countsByDay, setCountsByDay] = useState<Record<string, number>>({});

  const refresh = useCallback(() => {
    const now = new Date();
    setToday(now);
    setStreak(currentStreak(now));
    setCountsByDay(readReviewLog());
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener("get:punch-change", refresh);
    window.addEventListener("get:wordbook-change", refresh);
    window.addEventListener("get:review-log-change", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("get:punch-change", refresh);
      window.removeEventListener("get:wordbook-change", refresh);
      window.removeEventListener("get:review-log-change", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refresh]);

  useEffect(() => {
    if (today && !viewMonth) {
      setViewMonth({ year: today.getFullYear(), month: today.getMonth() });
    }
  }, [today, viewMonth]);

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
      <div className="rounded-[var(--radius-lg)] border border-white/70 bg-white/40 backdrop-blur-2xl p-5 h-full shadow-[var(--shadow-glass)]">
        <div className="h-4 w-24 animate-pulse rounded bg-white/50" />
        <div className="mt-4 h-40 animate-pulse rounded-md bg-white/40" />
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

  function keyOf(y: number, m: number, d: number): string {
    return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  // 今日的复习词数（用来判断"今日打卡"的实际数字）。同一 lemma 复习两次算 2。
  const todayCount = isCurrentMonth
    ? countsByDay[keyOf(year, month, todayDate)] ?? 0
    : 0;

  return (
    <div className="relative overflow-hidden rounded-[var(--radius-lg)] border border-white/70 bg-white/40 backdrop-blur-2xl shadow-[var(--shadow-glass)] h-full flex flex-col supports-[backdrop-filter]:bg-white/32">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[linear-gradient(140deg,rgba(255,255,255,0.42),rgba(255,255,255,0.10)_55%,transparent)]" />
        <div className="absolute inset-x-0 bottom-0 h-[38%] bg-gradient-to-t from-white/25 to-transparent" />
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[var(--highlight)]/35 blur-3xl" />
        <div className="absolute inset-0 rounded-[var(--radius-lg)] ring-1 ring-inset ring-white/50" />
      </div>

      {/* Month header */}
      <div className="relative px-6 pt-5 pb-3 shrink-0 flex items-center justify-between">
        <button
          type="button"
          onClick={goPrevMonth}
          aria-label="上一月"
          className="h-8 w-8 rounded-full border border-white/70 bg-white/60 text-[var(--fg-soft)] transition hover:bg-white/90 hover:text-[var(--fg)] active:scale-95"
        >
          ‹
        </button>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[19px] font-semibold tracking-tight text-[var(--fg)]">
            {monthLabel}
          </span>
          <span className="text-[13px] font-medium text-[var(--fg-soft)] tabular-nums">
            {year}
          </span>
        </div>
        <button
          type="button"
          onClick={goNextMonth}
          aria-label="下一月"
          className="h-8 w-8 rounded-full border border-white/70 bg-white/60 text-[var(--fg-soft)] transition hover:bg-white/90 hover:text-[var(--fg)] active:scale-95"
        >
          ›
        </button>
      </div>

      <div className="relative px-5 pb-2 flex-1 min-h-0 flex flex-col">
        <div className="grid grid-cols-7 text-center text-[10.5px] uppercase tracking-[0.14em] text-[var(--fg-soft)]/80 mb-1.5 shrink-0">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((w) => (
            <div key={w} className="py-1">
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-y-1.5 text-center flex-1 min-h-0">
          {cells.map((d, i) => {
            if (d === null) {
              return <div key={i} />;
            }
            const isPunched = punched.has(d);
            const isToday = isCurrentMonth && d === todayDate;
            const dayOfWeek = (firstDayOfMonth + d - 1) % 7;
            const prevPunched = punched.has(d - 1) && dayOfWeek !== 0;
            const nextPunched = punched.has(d + 1) && dayOfWeek !== 6;

            const pillBg = "rgba(106, 167, 195, 0.32)";
            const roundLeft = !prevPunched;
            const roundRight = !nextPunched;
            const pillLeft = prevPunched ? "0" : "4px";
            const pillRight = nextPunched ? "0" : "4px";

            const cnt = countsByDay[keyOf(year, month, d)] ?? 0;

            // Cell 结构：h-13 高，日期圆位于纵向居中位置；pill 与圆同一水平中心；
            // 复习词数数字在圆下方 6px 处，跟日期解耦（问题 8：往下一些）。
            return (
              <div
                key={i}
                className="relative flex h-13 flex-col items-center pt-[6px]"
                style={{ height: "3.25rem" /* h-13 alias */ }}
              >
                {isPunched && (
                  <div
                    className="pointer-events-none absolute"
                    style={{
                      backgroundColor: pillBg,
                      top: "6px",
                      height: "2rem", // 与日期圆等高
                      left: pillLeft,
                      right: pillRight,
                      borderTopLeftRadius: roundLeft ? "9999px" : 0,
                      borderBottomLeftRadius: roundLeft ? "9999px" : 0,
                      borderTopRightRadius: roundRight ? "9999px" : 0,
                      borderBottomRightRadius: roundRight ? "9999px" : 0,
                    }}
                  />
                )}
                <div
                  className={[
                    "relative z-10 flex h-8 w-8 items-center justify-center rounded-full mx-auto text-[13px] tabular-nums transition",
                    isToday
                      ? "bg-white ring-2 ring-[var(--accent)] text-[var(--accent)] font-semibold shadow-[0_4px_10px_rgba(106,167,195,0.35)]"
                      : isPunched
                      ? "text-[var(--accent)] font-semibold"
                      : "text-[var(--fg)]/85 hover:bg-white/50",
                  ].join(" ")}
                >
                  {d}
                </div>
                {/* 词数：浅蓝色小字，距离日期圆再往下 4px（mt-1） */}
                <div
                  className={[
                    "relative z-10 mt-1 leading-none text-[9.5px] tabular-nums",
                    cnt > 0
                      ? "text-[var(--accent)]/55"
                      : "text-transparent",
                  ].join(" ")}
                  title={cnt > 0 ? `${cnt} 词` : undefined}
                >
                  {cnt > 0 ? cnt : "·"}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 底部条：今日打卡 / 连续 X 天 / 开始复习 —— 排布改为左右分栏 */}
      <div className="relative border-t border-white/50 bg-white/50 backdrop-blur-md px-5 py-4 shrink-0">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold tracking-tight text-[var(--fg)]">
              今日打卡
              {todayCount > 0 && (
                <span className="ml-2 text-[13px] font-medium text-[var(--accent)] tabular-nums">
                  · {todayCount} 词
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[12px] text-[var(--fg-soft)]">
              连续
              <span className="mx-1 text-[15px] font-semibold text-[var(--accent)] tabular-nums">
                {streak}
              </span>
              天
            </div>
          </div>

          <Link
            href="/review"
            className="shrink-0 rounded-full bg-[var(--accent)] px-5 py-2 text-center text-[13px] font-semibold text-white shadow-[0_6px_14px_rgba(106,167,195,0.35)] transition whitespace-nowrap active:translate-y-[1px] hover:brightness-105"
          >
            开始复习
          </Link>
        </div>
      </div>
    </div>
  );
}
