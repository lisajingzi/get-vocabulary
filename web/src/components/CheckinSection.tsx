"use client";

import Link from "next/link";
import { useEffect, useState, useCallback } from "react";
import { currentStreak, punchesInMonth } from "@/lib/wordbook/punches";
import { readReviewLog } from "@/lib/wordbook/review-log";

export default function CheckinSection() {
  const [today, setToday] = useState<Date | null>(null);
  // viewMonth 用于支持用户切换查看月份；与"今天"分开存储。
  const [viewMonth, setViewMonth] = useState<{ year: number; month: number } | null>(null);
  const [punched, setPunched] = useState<Set<number>>(new Set());
  const [streak, setStreak] = useState(0);
  // 每一天的复习词数（同一 lemma 复习两次也算 2）——放到日期下方小灰字里。
  // 结构：{ "YYYY-MM-DD": count }
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

  return (
    <div className="relative overflow-hidden rounded-[var(--radius-lg)] border border-white/70 bg-white/40 backdrop-blur-2xl shadow-[var(--shadow-glass)] h-full flex flex-col supports-[backdrop-filter]:bg-white/32">
      {/* Frosted-glass layer stack — kept minimal for a clean feel */}
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
        <div className="grid grid-cols-7 gap-y-1 text-center flex-1 min-h-0">
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

            return (
              <div key={i} className="relative flex h-11 flex-col items-center justify-start pt-0.5">
                {isPunched && (
                  <div
                    className="pointer-events-none absolute top-1 h-8"
                    style={{
                      backgroundColor: pillBg,
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
                {/* 当日复习词数 — 小字浅灰色。0 时留出等高占位，避免高度抖动。 */}
                <div
                  className={[
                    "relative z-10 mt-0 h-3 leading-3 text-[9px] tabular-nums",
                    cnt > 0 ? "text-[var(--fg-soft)]/70" : "text-transparent",
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

      <div className="relative border-t border-white/50 bg-white/45 backdrop-blur-md px-4 py-3.5 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-x-3 min-w-0 flex-1 overflow-hidden">
            <div className="text-[14px] font-semibold tracking-tight whitespace-nowrap">今日打卡</div>
            <div className="flex items-baseline gap-1 text-[11px] text-[var(--fg-soft)] whitespace-nowrap">
              连续
              <span className="text-[14px] font-semibold text-[var(--accent)] tabular-nums">{streak}</span>
              天
            </div>
          </div>

          <Link
            href="/review"
            className="shrink-0 rounded-full bg-[var(--accent)] px-3 py-1.5 text-center text-xs font-semibold text-white shadow-[0_6px_14px_rgba(106,167,195,0.35)] transition whitespace-nowrap active:translate-y-[1px] hover:brightness-105"
          >
            开始复习
          </Link>
        </div>
      </div>
    </div>
  );
}
