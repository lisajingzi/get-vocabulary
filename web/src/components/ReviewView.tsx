"use client";

/**
 * <ReviewView /> — 复习流程重构版。
 *
 * 用户流：
 *   1. picker  → 用户选择筛选条件（雅思/非雅思、听说写/阅读、组名、已复习次数、错误次数）
 *      + 实时显示总数 → 点击「确认」进入方式选择。
 *   2. mode    → 用户在 识词 / 听写 之间二选一。
 *   3. review  → 按选择的方式复习每一个词：
 *      - 识词：先自评「认识 / 忘了」，再展示词义 + 例句 + 笔记 + 二级自评（认识后）
 *              进入下一题时自动播放；顶部展示 coreExample。
 *      - 听写：听音 → 拼写；进入题目时自动播放；提交后展示词义 + 例句 + 笔记。
 *   4. done    → 完成态。
 *
 * 错词本模式（通过 URL ?mode=wrongbook 进入）：
 *   - 跳过 picker，直接把词范围锁定为 entry.inWrongBook === true 的全部词，
 *     进入 mode → review → done。
 *   - 每次结果调用 recordReviewStats(..., { fromWrongBook: true })：
 *       * 复习正确 → inWrongBook = false，errorCount 不变；
 *       * 复习错误 → inWrongBook 保持 true，errorCount += 1。
 *
 * 打卡：每次复习结果（对/错）都记录到 review-log（`recordReviewEvent`），
 *      当天累计 > 0 → 触发 recordPunchToday()。这样错词本重温也算打卡。
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getEntry,
  listEntries,
  listNotes,
  recordReview,
  recordReviewStats,
  type WordbookEntry,
} from "@/lib/wordbook/local";
import { MAX_LEVEL } from "@/lib/wordbook/scheduler";
import { recordPunchToday } from "@/lib/wordbook/punches";
import { recordReviewEvent } from "@/lib/wordbook/review-log";
import SpeakButton from "@/components/SpeakButton";

/**
 * sessionStorage key for the current review session. Persists phase / queue
 * (as lemma[]) / cursor / mode / graded / confirmed / draft / feedback so
 * clicking a headword → detail page → back returns to the exact same
 * card in the exact same graded state. Cleared on `done` phase.
 */
const SESSION_KEY = "get:review-session:v1";

/** Serialisable snapshot of the review state — keep it small so we don't
 *  bump against sessionStorage size limits. */
type PersistedSession = {
  phase: "review";
  mode: ReviewMode;
  fromWrongBook: boolean;
  /** Lemma queue — we re-fetch entries from local storage on hydrate so
   *  state stays consistent with any changes the user made in between. */
  queue: string[];
  cursor: number;
  /** Per-card interaction snapshot for the CURRENT cursor (recognize mode). */
  graded?: "pass" | "fail" | null;
  confirmed?: "pass" | "fail" | null;
  /** Per-card interaction snapshot for the CURRENT cursor (spell mode). */
  spellDraft?: string;
  spellFeedback?: "right" | "wrong" | "revealed" | null;
};

function readSession(): PersistedSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedSession;
  } catch {
    return null;
  }
}

function writeSession(s: PersistedSession | null): void {
  if (typeof window === "undefined") return;
  try {
    if (s === null) window.sessionStorage.removeItem(SESSION_KEY);
    else window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** 复习方式：识词 = 看到词判断是否认识 + 展开例句/笔记；听写 = 听音拼写。 */
export type ReviewMode = "recognize" | "spell";

/** 筛选：雅思 / 非雅思 / 全部（必选，默认 all）。 */
type IeltsFilter = "all" | "ielts" | "nonielts";
/** 筛选：听说写 / 阅读 / 全部（必选，默认 all）。 */
type PurposeFilter = "all" | "active" | "passive";

interface FilterState {
  ielts: IeltsFilter;
  purpose: PurposeFilter;
  /** 仅当 ielts === "ielts" 时展示。空数组 = 不限；否则要求 entry.group ∈ 该集合。 */
  groups: string[];
  /** 已复习次数（可多选具体数值）。空数组 = 不限。 */
  reviewCounts: number[];
  /** 错误次数（可多选具体数值）。空数组 = 不限。 */
  errorCounts: number[];
}

const emptyFilter: FilterState = {
  ielts: "all",
  purpose: "all",
  groups: [],
  reviewCounts: [],
  errorCounts: [],
};

type Phase =
  | { kind: "picker" }
  | { kind: "mode-picker"; entries: WordbookEntry[] }
  | {
      kind: "review";
      queue: WordbookEntry[];
      cursor: number;
      mode: ReviewMode;
      fromWrongBook: boolean;
    }
  | { kind: "done"; finished: number; total: number };

function isWrongBookMode(v: string | null | undefined): boolean {
  return v === "wrongbook";
}

export default function ReviewView() {
  const searchParams = useSearchParams();
  const wrongBookMode = useMemo(
    () => isWrongBookMode(searchParams?.get("mode") ?? null),
    [searchParams],
  );

  const [phase, setPhase] = useState<Phase>({ kind: "picker" });

  // On first mount, try to restore an in-progress review session from
  // sessionStorage. This is what makes "answer page → click headword →
  // detail → back" return you to the same card in the same graded state
  // instead of dropping you back onto the picker (React state is lost when
  // /review remounts on navigation, but sessionStorage survives).
  //
  // Guarded by a ref so the hydrate only runs once — subsequent effects
  // (e.g. wrongBookMode changes) don't fight the hydrated state.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const s = readSession();
    if (!s || s.phase !== "review") return;
    // Re-fetch entries by lemma so any wordbook edits between navigations
    // (mark 老朋友, delete, etc.) are respected. Skip missing ones.
    const queue: WordbookEntry[] = [];
    for (const lemma of s.queue) {
      const e = getEntry(lemma);
      if (e) queue.push(e);
    }
    if (queue.length === 0) {
      writeSession(null);
      return;
    }
    const cursor = Math.min(Math.max(0, s.cursor), queue.length - 1);
    setPhase({
      kind: "review",
      queue,
      cursor,
      mode: s.mode,
      fromWrongBook: s.fromWrongBook,
    });
  }, []);

  // Persist the current phase into sessionStorage whenever it changes.
  // Only the "review" phase carries state worth restoring; picker /
  // mode-picker / done get wiped so a fresh visit starts clean.
  useEffect(() => {
    if (phase.kind === "review") {
      writeSession({
        phase: "review",
        mode: phase.mode,
        fromWrongBook: phase.fromWrongBook,
        queue: phase.queue.map((e) => e.lemma),
        cursor: phase.cursor,
      });
    } else if (phase.kind === "done") {
      writeSession(null);
    }
    // picker / mode-picker — leave the previous session alone in case
    // the user meant to return; on "done" we clear it.
  }, [phase]);

  // 错词本模式：直接跳过 picker，把 inWrongBook === true 的词全部塞进去，
  // 进入方式选择。
  useEffect(() => {
    if (!wrongBookMode) return;
    const wrong = listEntries().filter((e) => e.inWrongBook === true);
    setPhase({ kind: "mode-picker", entries: wrong });
  }, [wrongBookMode]);

  const advance = useCallback(
    (result: "pass" | "fail") => {
      setPhase((prev) => {
        if (prev.kind !== "review") return prev;
        const item = prev.queue[prev.cursor];
        if (item) {
          // 1) 艾宾浩斯曲线：level 增减 + nextReviewAt 更新。
          recordReview(item.lemma, result);
          // 2) 统计字段：reviewCount / errorCount / inWrongBook。
          recordReviewStats(item.lemma, result, {
            fromWrongBook: prev.fromWrongBook,
          });
          // 3) 打卡日志：+1；触发当日 punch。
          recordReviewEvent();
          recordPunchToday();
        }
        const nextCursor = prev.cursor + 1;
        if (nextCursor >= prev.queue.length) {
          return { kind: "done", finished: prev.queue.length, total: prev.queue.length };
        }
        return { ...prev, cursor: nextCursor };
      });
    },
    [],
  );

  if (phase.kind === "picker") {
    return (
      <div className="space-y-4">
        <ReviewTopBar wrongBook={wrongBookMode} />
        <FilterPicker
          onConfirm={(entries) =>
            entries.length === 0
              ? setPhase({ kind: "done", finished: 0, total: 0 })
              : setPhase({ kind: "mode-picker", entries })
          }
        />
      </div>
    );
  }

  if (phase.kind === "mode-picker") {
    return (
      <div className="space-y-4">
        <ReviewTopBar wrongBook={wrongBookMode} />
        <ModePicker
          total={phase.entries.length}
          wrongBook={wrongBookMode}
          onPick={(mode) =>
            phase.entries.length === 0
              ? setPhase({ kind: "done", finished: 0, total: 0 })
              : setPhase({
                  kind: "review",
                  queue: phase.entries,
                  cursor: 0,
                  mode,
                  fromWrongBook: wrongBookMode,
                })
          }
          onBack={() =>
            wrongBookMode
              ? setPhase({ kind: "done", finished: 0, total: 0 })
              : setPhase({ kind: "picker" })
          }
        />
      </div>
    );
  }

  if (phase.kind === "done") {
    return (
      <div className="space-y-4">
        <ReviewTopBar wrongBook={wrongBookMode} />
        <DoneState
          finished={phase.finished}
          total={phase.total}
          onReset={() =>
            wrongBookMode
              ? // 错词本模式退出到错词本首页
                (window.location.href = "/wrongbook")
              : setPhase({ kind: "picker" })
          }
        />
      </div>
    );
  }

  // review
  const item = phase.queue[phase.cursor];
  return (
    <div className="space-y-4">
      <ReviewTopBar wrongBook={wrongBookMode} />
      <ProgressBar current={phase.cursor + 1} total={phase.queue.length} />
      {phase.mode === "recognize" ? (
        <RecognizeCard
          key={item.lemma}
          entry={item}
          onAdvance={advance}
          onCardState={(gr, cf) => {
            const s = readSession();
            if (s && s.phase === "review") {
              writeSession({ ...s, graded: gr, confirmed: cf });
            }
          }}
          initialGraded={
            (() => {
              const s = readSession();
              return s?.phase === "review" && s.cursor === phase.cursor
                ? (s.graded ?? null)
                : null;
            })()
          }
          initialConfirmed={
            (() => {
              const s = readSession();
              return s?.phase === "review" && s.cursor === phase.cursor
                ? (s.confirmed ?? null)
                : null;
            })()
          }
        />
      ) : (
        <SpellCard
          key={item.lemma}
          entry={item}
          onAdvance={advance}
          onCardState={(draft, feedback) => {
            const s = readSession();
            if (s && s.phase === "review") {
              writeSession({
                ...s,
                spellDraft: draft,
                spellFeedback: feedback,
              });
            }
          }}
          initialDraft={
            (() => {
              const s = readSession();
              return s?.phase === "review" && s.cursor === phase.cursor
                ? (s.spellDraft ?? "")
                : "";
            })()
          }
          initialFeedback={
            (() => {
              const s = readSession();
              return s?.phase === "review" && s.cursor === phase.cursor
                ? (s.spellFeedback ?? null)
                : null;
            })()
          }
        />
      )}
    </div>
  );
}

// ===========================================================================
// TopBar / Progress / Done
// ===========================================================================

function ReviewTopBar({ wrongBook }: { wrongBook: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <Link
        href={wrongBook ? "/wrongbook" : "/"}
        className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs text-[var(--fg-soft)] transition hover:border-[var(--accent)] hover:text-[var(--fg)]"
      >
        <span aria-hidden>←</span>
        {wrongBook ? "返回错词本" : "返回首页"}
      </Link>
      {wrongBook && (
        <span className="rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-500">
          重温错词
        </span>
      )}
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

function DoneState({
  finished,
  total,
  onReset,
}: {
  finished: number;
  total: number;
  onReset: () => void;
}) {
  return (
    <div className="space-y-3 rounded-xl border border-[var(--border)] p-6 text-center">
      <p className="text-2xl">🎉</p>
      <p className="text-base font-medium">
        {total === 0
          ? "没有符合条件的单词"
          : `本次 ${finished} / ${total} 个单词已完成`}
      </p>
      <p className="text-sm text-[var(--fg-soft)]">
        <button
          type="button"
          onClick={onReset}
          className="text-[var(--accent)] hover:underline"
        >
          再来一次
        </button>
        ，或者
        <Link href="/" className="mx-1 text-[var(--accent)] hover:underline">
          回首页
        </Link>
        看看打卡日历。
      </p>
    </div>
  );
}

// ===========================================================================
// Filter Picker
// ===========================================================================

function FilterPicker({
  onConfirm,
}: {
  onConfirm: (entries: WordbookEntry[]) => void;
}) {
  const [allEntries, setAllEntries] = useState<WordbookEntry[]>([]);
  const [filter, setFilter] = useState<FilterState>(emptyFilter);

  useEffect(() => {
    setAllEntries(listEntries());
  }, []);

  // 派生：候选的组名（仅雅思词）、复习次数集合、错误次数集合。
  const allGroups = useMemo(() => {
    const set = new Set<string>();
    for (const e of allEntries) {
      if (e.ielts !== true) continue;
      if (e.group && e.group.trim().length > 0) set.add(e.group);
    }
    return Array.from(set).sort();
  }, [allEntries]);

  const allReviewCounts = useMemo(() => {
    const set = new Set<number>();
    for (const e of allEntries) set.add(e.reviewCount ?? 0);
    return Array.from(set).sort((a, b) => a - b);
  }, [allEntries]);

  const allErrorCounts = useMemo(() => {
    const set = new Set<number>();
    for (const e of allEntries) set.add(e.errorCount ?? 0);
    return Array.from(set).sort((a, b) => a - b);
  }, [allEntries]);

  // 应用筛选：命中的词条列表 + 总数（复习范围仅限还没毕业的 new 词）。
  // 为了让 UI 能"灰化不可选"（方案 B），我们抽出一个 passOthers helper：
  // 它跑所有筛选维度，但可以 skip 掉指定的一维，用来判断"如果只按其他条件
  // 筛，这个词是否还在候选池里"。三个 available* 集合就是靠它派生的。
  const passesFilter = (
    e: WordbookEntry,
    skip: "ielts" | "purpose" | "groups" | "reviewCounts" | "errorCounts" | "none",
  ): boolean => {
    if (e.status !== "new") return false;
    if (e.level >= MAX_LEVEL) return false;
    if (skip !== "ielts") {
      if (filter.ielts === "ielts" && e.ielts !== true) return false;
      if (filter.ielts === "nonielts" && e.ielts === true) return false;
    }
    if (skip !== "purpose" && filter.purpose !== "all") {
      const actual = e.purpose ?? "active";
      if (actual !== filter.purpose) return false;
    }
    if (skip !== "groups" && filter.ielts === "ielts" && filter.groups.length > 0) {
      if (!e.group || !filter.groups.includes(e.group)) return false;
    }
    if (skip !== "reviewCounts" && filter.reviewCounts.length > 0) {
      if (!filter.reviewCounts.includes(e.reviewCount ?? 0)) return false;
    }
    if (skip !== "errorCounts" && filter.errorCounts.length > 0) {
      if (!filter.errorCounts.includes(e.errorCount ?? 0)) return false;
    }
    return true;
  };

  const matched = useMemo(() => {
    return allEntries.filter((e) => passesFilter(e, "none"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allEntries, filter]);

  // 「组名」候选：在忽略 groups 自身的前提下、其他维度筛完剩下的雅思词里
  // 出现过哪些 group。
  const availableGroups = useMemo(() => {
    const set = new Set<string>();
    for (const e of allEntries) {
      if (!passesFilter(e, "groups")) continue;
      if (e.ielts !== true) continue;
      if (e.group && e.group.trim().length > 0) set.add(e.group);
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allEntries, filter]);

  const availableReviewCounts = useMemo(() => {
    const set = new Set<number>();
    for (const e of allEntries) {
      if (!passesFilter(e, "reviewCounts")) continue;
      set.add(e.reviewCount ?? 0);
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allEntries, filter]);

  const availableErrorCounts = useMemo(() => {
    const set = new Set<number>();
    for (const e of allEntries) {
      if (!passesFilter(e, "errorCounts")) continue;
      set.add(e.errorCount ?? 0);
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allEntries, filter]);

  function toggle<T>(arr: T[], v: T): T[] {
    return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  }

  return (
    <section className="space-y-5 rounded-xl border border-[var(--border)] p-5">
      <header className="space-y-1">
        <h2 className="text-base font-semibold tracking-tight">选择复习内容</h2>
        <p className="text-xs text-[var(--fg-soft)]">
          先选类型再选方式；下方会实时计算命中的单词总数。
        </p>
      </header>

      {/* 雅思 / 非雅思 —— 必选组 */}
      <div className="space-y-1.5">
        <p className="text-[11px] font-medium text-[var(--fg-soft)]">
          雅思归属（必选）
        </p>
        <div
          className="inline-flex rounded-md border border-[var(--border)] p-0.5"
          role="radiogroup"
        >
          {(
            [
              { key: "all", label: "全部" },
              { key: "ielts", label: "雅思" },
              { key: "nonielts", label: "非雅思" },
            ] as const
          ).map((it) => {
            const active = filter.ielts === it.key;
            return (
              <button
                key={it.key}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() =>
                  setFilter((f) => ({
                    ...f,
                    ielts: it.key,
                    // 切换到非雅思时清空组名筛选。
                    groups: it.key === "ielts" ? f.groups : [],
                  }))
                }
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
      </div>

      {/* 复习方式（听说写 / 阅读）—— 必选 */}
      <div className="space-y-1.5">
        <p className="text-[11px] font-medium text-[var(--fg-soft)]">
          学习方式（必选）
        </p>
        <div
          className="inline-flex rounded-md border border-[var(--border)] p-0.5"
          role="radiogroup"
        >
          {(
            [
              { key: "all", label: "全部" },
              { key: "active", label: "听说写" },
              { key: "passive", label: "阅读" },
            ] as const
          ).map((it) => {
            const active = filter.purpose === it.key;
            return (
              <button
                key={it.key}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setFilter((f) => ({ ...f, purpose: it.key }))}
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
      </div>

      {/* 雅思组名 —— 仅在 ielts === "ielts" 时展示；可多选 */}
      {filter.ielts === "ielts" && allGroups.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-[var(--fg-soft)]">
            雅思组名 <span className="text-[var(--fg)]">（可多选）</span>，留空 = 全部组
          </p>
          <div className="flex flex-wrap gap-1.5">
            {allGroups.map((g) => {
              const active = filter.groups.includes(g);
              const disabled = !active && !availableGroups.has(g);
              return (
                <button
                  key={g}
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    setFilter((f) => ({ ...f, groups: toggle(f.groups, g) }))
                  }
                  className={[
                    "rounded-full border px-2.5 py-0.5 text-[11px] transition",
                    active
                      ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                      : disabled
                        ? "border-[var(--border)]/50 text-[var(--fg-soft)]/40 cursor-not-allowed"
                        : "border-[var(--border)] text-[var(--fg-soft)] hover:border-[var(--fg-soft)] hover:text-[var(--fg)]",
                  ].join(" ")}
                >
                  {g}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 已复习次数（可多选具体值）*/}
      {allReviewCounts.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-[var(--fg-soft)]">
            已复习次数 <span className="text-[var(--fg)]">（可多选）</span>，留空 = 不限
          </p>
          <div className="flex flex-wrap gap-1.5">
            {allReviewCounts.map((n) => {
              const active = filter.reviewCounts.includes(n);
              const disabled = !active && !availableReviewCounts.has(n);
              return (
                <button
                  key={n}
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    setFilter((f) => ({
                      ...f,
                      reviewCounts: toggle(f.reviewCounts, n),
                    }))
                  }
                  className={[
                    "rounded-full border px-2.5 py-0.5 text-[11px] tabular-nums transition",
                    active
                      ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                      : disabled
                        ? "border-[var(--border)]/50 text-[var(--fg-soft)]/40 cursor-not-allowed"
                        : "border-[var(--border)] text-[var(--fg-soft)] hover:border-[var(--fg-soft)] hover:text-[var(--fg)]",
                  ].join(" ")}
                >
                  {n}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 错误次数（可多选具体值）*/}
      {allErrorCounts.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-[var(--fg-soft)]">
            错误次数 <span className="text-[var(--fg)]">（可多选）</span>，留空 = 不限
          </p>
          <div className="flex flex-wrap gap-1.5">
            {allErrorCounts.map((n) => {
              const active = filter.errorCounts.includes(n);
              const disabled = !active && !availableErrorCounts.has(n);
              return (
                <button
                  key={n}
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    setFilter((f) => ({
                      ...f,
                      errorCounts: toggle(f.errorCounts, n),
                    }))
                  }
                  className={[
                    "rounded-full border px-2.5 py-0.5 text-[11px] tabular-nums transition",
                    active
                      ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                      : disabled
                        ? "border-[var(--border)]/50 text-[var(--fg-soft)]/40 cursor-not-allowed"
                        : "border-[var(--border)] text-[var(--fg-soft)] hover:border-[var(--fg-soft)] hover:text-[var(--fg)]",
                  ].join(" ")}
                >
                  {n}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 汇总 & 确认按钮 */}
      <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
        <p className="text-sm">
          <span className="text-[var(--fg-soft)]">符合条件的单词：</span>
          <span className="font-semibold text-[var(--fg)] tabular-nums">
            {matched.length}
          </span>
          <span className="ml-0.5 text-[var(--fg-soft)]">个</span>
        </p>
        <button
          type="button"
          onClick={() => onConfirm(matched)}
          disabled={matched.length === 0}
          className="rounded-md bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
        >
          确认 →
        </button>
      </div>
    </section>
  );
}

// ===========================================================================
// Mode Picker
// ===========================================================================

function ModePicker({
  total,
  wrongBook,
  onPick,
  onBack,
}: {
  total: number;
  wrongBook: boolean;
  onPick: (m: ReviewMode) => void;
  onBack: () => void;
}) {
  return (
    <section className="space-y-4 rounded-xl border border-[var(--border)] p-5">
      <header className="space-y-1">
        <h2 className="text-base font-semibold tracking-tight">选择复习方式</h2>
        <p className="text-xs text-[var(--fg-soft)]">
          共 <span className="font-semibold text-[var(--fg)]">{total}</span> 个单词，选一种方式开始。
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onPick("recognize")}
          disabled={total === 0}
          className="group flex flex-col items-start rounded-xl border border-[var(--border)] p-4 text-left transition hover:border-[var(--accent)] hover:shadow-sm active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="text-[13px] uppercase tracking-wider text-[var(--fg-soft)]">
            Mode A
          </span>
          <span className="mt-1 text-lg font-semibold group-hover:text-[var(--accent)]">
            识词
          </span>
          <span className="mt-2 text-xs text-[var(--fg-soft)]">
            看见词形自评「认识 / 忘了」，展示例句、核心短语和笔记，最后二次确认。
          </span>
        </button>
        <button
          type="button"
          onClick={() => onPick("spell")}
          disabled={total === 0}
          className="group flex flex-col items-start rounded-xl border border-[var(--border)] p-4 text-left transition hover:border-[var(--accent)] hover:shadow-sm active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="text-[13px] uppercase tracking-wider text-[var(--fg-soft)]">
            Mode B
          </span>
          <span className="mt-1 text-lg font-semibold group-hover:text-[var(--accent)]">
            听写
          </span>
          <span className="mt-2 text-xs text-[var(--fg-soft)]">
            听音后拼写；进入题目时自动播放一次，也可反复播放。
          </span>
        </button>
      </div>

      <div className="flex justify-start">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-[var(--fg-soft)] underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]"
        >
          {wrongBook ? "← 放弃重温" : "← 返回重新筛选"}
        </button>
      </div>
    </section>
  );
}

// ===========================================================================
// Recognize Card — 识词模式
// ===========================================================================

interface Gloss {
  pos?: string;
  def?: string;
  chn?: string;
  example?: { en: string; cn?: string };
}

function useAutoPlay(target: string) {
  // 每次 target 变化时自动播放一次单词朗读。使用 Web Speech API 兜底；
  // 若 SpeakButton 使用自定义音频（如 COS），这里的自动播放依然生效因为
  // 全站朗读走同一套 lib/tts。
  useEffect(() => {
    if (typeof window === "undefined") return;
    // 惯例：项目内使用 window.speechSynthesis，SpeakButton 也走同一套。
    try {
      const utter = new SpeechSynthesisUtterance(target);
      utter.lang = "en-US";
      utter.rate = 0.95;
      // 稍后一点播放，避免 UI 未挂载时被忽略。
      const id = window.setTimeout(() => {
        try {
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(utter);
        } catch {
          /* noop */
        }
      }, 200);
      return () => window.clearTimeout(id);
    } catch {
      return;
    }
  }, [target]);
}

function useGloss(target: string): Gloss[] | null {
  const [senses, setSenses] = useState<Gloss[] | null>(null);
  useEffect(() => {
    setSenses(null);
    let cancelled = false;
    void (async () => {
      const { lookup } = await import("@/lib/dict");
      const got = await lookup(target);
      if (cancelled) return;
      const all = got?.entry.senses ?? [];
      // 按 POS 去重优先，最多 2 条。
      const seenPos = new Set<string>();
      const primary: typeof all = [];
      const rest: typeof all = [];
      for (const s of all) {
        const key = (s.pos ?? "").trim();
        if (key && !seenPos.has(key)) {
          seenPos.add(key);
          primary.push(s);
        } else {
          rest.push(s);
        }
      }
      const picked = [...primary, ...rest].slice(0, 2);
      setSenses(
        picked.map((s) => ({
          pos: s.pos,
          def: s.def,
          chn: s.chn,
          example: s.ex && s.ex.length > 0 ? s.ex[0] : undefined,
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);
  return senses;
}

/** 只提取笔记的正文数组，供识词模式底部展示。 */
function useNotes(target: string): { body: string }[] {
  const [notes, setNotes] = useState<{ body: string }[]>([]);
  useEffect(() => {
    setNotes(listNotes(target).map((n) => ({ body: n.body })));
  }, [target]);
  return notes;
}

function RecognizeCard({
  entry,
  onAdvance,
  onCardState,
  initialGraded,
  initialConfirmed,
}: {
  entry: WordbookEntry;
  onAdvance: (result: "pass" | "fail") => void;
  onCardState?: (
    graded: "pass" | "fail" | null,
    confirmed: "pass" | "fail" | null,
  ) => void;
  initialGraded?: "pass" | "fail" | null;
  initialConfirmed?: "pass" | "fail" | null;
}) {
  const target = entry.lemma;
  useAutoPlay(target);
  const senses = useGloss(target);
  const notes = useNotes(target);
  // 一级自评：认识 / 忘了；二级自评：记对了 / 记错了（仅当一级 = 认识 时启用）。
  // 初始值从父传入（从 sessionStorage 恢复）。
  const [graded, setGradedRaw] = useState<"pass" | "fail" | null>(
    initialGraded ?? null,
  );
  const [confirmed, setConfirmedRaw] = useState<"pass" | "fail" | null>(
    initialConfirmed ?? null,
  );

  const setGraded = useCallback(
    (v: "pass" | "fail" | null) => {
      setGradedRaw(v);
      // reset confirmed 交给调用处，这里只同步 session。
      onCardState?.(v, confirmed);
    },
    [onCardState, confirmed],
  );
  const setConfirmed = useCallback(
    (v: "pass" | "fail" | null) => {
      setConfirmedRaw(v);
      onCardState?.(graded, v);
    },
    [onCardState, graded],
  );

  return (
    <section className="space-y-4">
      {/* 头部 — 词形与核心例句。 */}
      <div className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <Link
            href={`/word/${encodeURIComponent(target)}?from=review`}
            className="text-2xl font-semibold tracking-tight underline decoration-transparent underline-offset-4 transition hover:decoration-[var(--accent)] hover:text-[var(--accent)]"
            title="点击查看单词详情（返回可回到本页）"
          >
            {target}
          </Link>
          <SpeakButton text={target} variant="us" />
        </div>
        {/* 核心短语 / 例句 — 字号相比之前大一些（text-sm），目标单词加“点点下划线”以快速定位。
            只展英文部分（stripChinese），不暴露中文释义。 */}
        {entry.coreExample && (
          <p className="text-sm leading-relaxed text-[var(--fg)]/80">
            <CoreExampleText
              text={stripChinese(entry.coreExample)}
              target={target}
            />
          </p>
        )}
      </div>

      {/* 一级自评 */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setGraded("pass");
            setConfirmed(null);
          }}
          className={[
            "rounded-md border px-3 py-1.5 text-sm transition",
            graded === "pass"
              ? "border-[var(--accent)] bg-[var(--accent)] text-white"
              : "border-[var(--border)] hover:border-[var(--accent)]",
          ].join(" ")}
        >
          ✓ 认识
        </button>
        <button
          type="button"
          onClick={() => {
            // 忘了 = 本题终局判失败，但先展开释义/笔记让用户熟悉一下，
            // 再点“下一题”才推进；不再立刻切走。
            setGraded("fail");
            setConfirmed(null);
          }}
          className={[
            "rounded-md border px-3 py-1.5 text-sm transition",
            graded === "fail"
              ? "border-red-400 bg-red-500 text-white"
              : "border-[var(--border)] hover:border-red-400 hover:text-red-500",
          ].join(" ")}
        >
          ✗ 忘了
        </button>
      </div>

      {/* 释义 / 例句 / 笔记 — 一级自评后展示；拆成三个白底卡片，层次清晰。 */}
      {graded !== null && (
        <div className="space-y-3">
          {/* 词义卡片（白底） */}
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
            <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-[var(--accent)]">
              释义
            </h3>
            {senses === null ? (
              <p className="text-xs text-[var(--fg-soft)]">加载释义中…</p>
            ) : senses.length === 0 ? (
              <p className="text-xs text-[var(--fg-soft)]">
                未找到详细释义，可
                <Link
                  href={`/word/${encodeURIComponent(target)}?from=review`}
                  className="mx-1 text-[var(--accent)] hover:underline"
                >
                  进入详情页
                </Link>
                查看。
              </p>
            ) : (
              <ul className="space-y-3">
                {senses.map((s, i) => (
                  <li
                    key={i}
                    className={
                      i > 0
                        ? "space-y-1 border-t border-[var(--border)] pt-3"
                        : "space-y-1"
                    }
                  >
                    <div className="flex items-baseline gap-2">
                      {s.pos && (
                        <span className="rounded bg-[var(--bg-soft)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--fg-soft)]">
                          {s.pos}
                        </span>
                      )}
                      {s.chn && (
                        <span className="text-sm text-[var(--fg)]">
                          {s.chn}
                        </span>
                      )}
                    </div>
                    {s.def && (
                      <p className="text-xs leading-relaxed text-[var(--fg-soft)]">
                        {s.def}
                      </p>
                    )}
                    {s.example && (
                      <div className="mt-1 space-y-0.5 border-l-2 border-[var(--border)] pl-3">
                        <p className="text-sm italic leading-relaxed text-[var(--fg)]">
                          “{s.example.en}”
                        </p>
                        {s.example.cn && (
                          <p className="text-xs leading-relaxed text-[var(--fg-soft)]">
                            {s.example.cn}
                          </p>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 笔记卡片（白底）——有笔记时才渲染，不占位。 */}
          {notes.length > 0 && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
              <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-[var(--accent)]">
                我的笔记
              </h3>
              <ul className="space-y-2">
                {notes.map((n, i) => (
                  <li
                    key={i}
                    className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--fg)]"
                  >
                    {n.body}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 二级自评：仅在一级 = 认识 时出现。点击 = 直接判定 + 进下一题，
              不再需要额外的“下一题”按钮。 */}
          {graded === "pass" && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 space-y-2">
              <p className="text-[11px] font-medium text-[var(--fg-soft)]">
                对照释义后，你刚才想的意思——
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setConfirmed("pass");
                    onAdvance("pass");
                  }}
                  className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs transition hover:border-[var(--accent)] hover:bg-[var(--accent)] hover:text-white"
                >
                  ✓ 记对了
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmed("fail");
                    onAdvance("fail");
                  }}
                  className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs transition hover:border-red-400 hover:bg-red-500 hover:text-white"
                >
                  ✗ 记错了
                </button>
              </div>
            </div>
          )}

          {/* 一级 = 忘了：本题已判失败，展开释义供熟悉；手动“下一题”推进。 */}
          {graded === "fail" && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 flex items-center justify-between gap-3">
              <p className="text-[11px] text-[var(--fg-soft)]">
                熟悉一下再走，本题已计为「未掌握」。
              </p>
              <button
                type="button"
                onClick={() => onAdvance("fail")}
                className="rounded-md bg-[var(--accent)] px-4 py-1.5 text-xs font-medium text-white transition hover:brightness-105"
              >
                下一题 →
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * <CoreExampleText /> — renders a sentence with the target word underlined
 * with a dotted line so the user can spot it quickly in the example.
 *
 * Case-insensitive whole-word match. If the target appears multiple times,
 * only the first hit is underlined — keeps the visual focused. If the
 * target isn't found (which happens for phrase-collocations that don't
 * literally include the lemma), we render the sentence unchanged.
 */
function CoreExampleText({
  text,
  target,
}: {
  text: string;
  target: string;
}) {
  const idx = text.toLowerCase().indexOf(target.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span className="underline decoration-dotted decoration-2 decoration-[var(--accent)] underline-offset-4">
        {text.slice(idx, idx + target.length)}
      </span>
      {text.slice(idx + target.length)}
    </>
  );
}
/** 从 "en — cn" 或 "en-cn" 类混合字符串里剥掉中文部分，只留英文。 */
function stripChinese(s: string): string {
  // 优先切 " — "、"—"、" - "，取第一个 chunk。
  for (const sep of [" — ", "—", " – ", "–", " - "]) {
    const idx = s.indexOf(sep);
    if (idx > 0) return s.slice(0, idx).trim();
  }
  // 否则删掉所有 CJK 字符。
  return s.replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, "").trim();
}

// ===========================================================================
// Spell Card — 听写模式
// ===========================================================================

function SpellCard({
  entry,
  onAdvance,
  onCardState,
  initialDraft,
  initialFeedback,
}: {
  entry: WordbookEntry;
  onAdvance: (result: "pass" | "fail") => void;
  onCardState?: (
    draft: string,
    feedback: "right" | "wrong" | "revealed" | null,
  ) => void;
  initialDraft?: string;
  initialFeedback?: "right" | "wrong" | "revealed" | null;
}) {
  const target = entry.lemma;
  useAutoPlay(target);
  const senses = useGloss(target);
  const notes = useNotes(target);

  const [draft, setDraftRaw] = useState(initialDraft ?? "");
  const [feedback, setFeedbackRaw] = useState<
    "right" | "wrong" | "revealed" | null
  >(initialFeedback ?? null);
  const inputRef = useRef<HTMLInputElement>(null);

  const setDraft = useCallback(
    (v: string) => {
      setDraftRaw(v);
      onCardState?.(v, feedback);
    },
    [onCardState, feedback],
  );
  const setFeedback = useCallback(
    (v: "right" | "wrong" | "revealed" | null) => {
      setFeedbackRaw(v);
      onCardState?.(draft, v);
    },
    [onCardState, draft],
  );

  // Reset only when target changes AND we don't have hydrated initial state
  // for this new target. If the parent already provided initialDraft /
  // initialFeedback (session hydrate), respect them.
  const didHydrateRef = useRef(false);
  useEffect(() => {
    if (didHydrateRef.current) {
      // subsequent target changes
      setDraftRaw("");
      setFeedbackRaw(null);
    }
    didHydrateRef.current = true;
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  function submit() {
    const guess = draft.trim().toLowerCase();
    if (!guess) return;
    if (guess === target.toLowerCase()) {
      setFeedback("right");
    } else {
      setFeedback("wrong");
    }
  }

  function giveUp() {
    setFeedback("revealed");
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
              if (feedback === "right" || feedback === "revealed") {
                onAdvance(feedback === "right" ? "pass" : "fail");
              } else if (feedback === "wrong") retry();
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
            onClick={() => onAdvance(feedback === "right" ? "pass" : "fail")}
            className="rounded-md border border-[var(--accent)] bg-[var(--accent)] px-3 py-2 text-xs text-white transition hover:opacity-90"
          >
            下一题 →
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

      {(feedback === "right" || feedback === "revealed") && (
        <div
          className={[
            "space-y-3 rounded-lg border p-3 text-sm",
            feedback === "right"
              ? "border-[var(--accent)]/40 bg-[var(--accent-soft)]/40"
              : "border-red-200 bg-red-50/60 dark:border-red-900/40 dark:bg-red-950/20",
          ].join(" ")}
        >
          <div className="space-y-0.5">
            <div className="flex items-baseline gap-2">
              <span className="text-base font-semibold">{target}</span>
              {senses?.[0]?.pos && (
                <span className="text-[10px] text-[var(--fg-soft)]">
                  ({senses[0].pos})
                </span>
              )}
            </div>
            {senses?.[0]?.def && (
              <p className="text-xs text-[var(--fg)]">{senses[0].def}</p>
            )}
            {senses?.[0]?.chn && (
              <p className="text-xs text-[var(--fg-soft)]">{senses[0].chn}</p>
            )}
          </div>

          {senses?.[0]?.example && (
            <div className="space-y-0.5 rounded-md border border-[var(--border)]/60 bg-[var(--bg)] px-2 py-1.5">
              <p className="text-xs italic leading-relaxed text-[var(--fg)]">
                “{senses[0].example.en}”
              </p>
              {senses[0].example.cn && (
                <p className="text-[11px] leading-relaxed text-[var(--fg-soft)]">
                  {senses[0].example.cn}
                </p>
              )}
            </div>
          )}

          {notes.length > 0 && (
            <div className="space-y-1.5 border-t border-[var(--border)]/60 pt-2">
              <p className="text-[11px] font-medium text-[var(--fg-soft)]">
                我的笔记
              </p>
              <ul className="space-y-1.5">
                {notes.map((n, i) => (
                  <li
                    key={i}
                    className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--fg)]"
                  >
                    {n.body}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
