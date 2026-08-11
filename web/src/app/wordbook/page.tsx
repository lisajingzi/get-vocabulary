"use client";

/**
 * /wordbook — personal wordbook page.
 *
 * Two top-level tabs (新朋友 / 老朋友). Below them, three filters that work
 * independently per tab:
 *   - Part-of-speech filter (verb / noun / adjective / adverb / 全部 / 其他)
 *   - Month filter — group by natural month (e.g. 2026年06月) using
 *     `lastQueriedAt`. Selecting a month restricts the list to entries whose
 *     latest search-bar lookup falls in that month.
 *   - Sort selector (recent / count / alpha).
 *
 * The right-side counter ("共 xxx 个") follows whatever filters are active.
 *
 * Each row carries a one-shot move button:
 *   - On the 新朋友 tab → ✅ moves the word to 老朋友
 *   - On the 老朋友 tab → 🧐 moves the word back to 新朋友
 * The move is immediate; a transient toast offers an undo for 5 seconds.
 *
 * Date column: shows `lastQueriedAt` (search-bar lookups only) formatted as
 * `06月11日` for current-year, `2025年06月11日` across years. We deliberately
 * do NOT use `lastSeenAt` here — clicking a word from inside the wordbook
 * list to view its detail is not a "query".
 */

import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import {
  listEntries,
  setStatus,
  type WordbookEntry,
  type WordbookPurpose,
  type WordbookStatus,
} from "@/lib/wordbook/local";
import SpeakButton from "@/components/SpeakButton";
import DefinitionModal from "@/components/DefinitionModal";

type SortKey = "recent" | "count" | "alpha";
/** “all” = 不筛选。后两项对应 WordbookPurpose。 */
type PurposeFilter = "all" | WordbookPurpose;
/** 雅思筛选：与 purpose 正交的独立胶囊组。
 *   - "all"    → 不筛
 *   - "ielts"  → 仅雅思（entry.ielts === true）
 *   - "nonielts" → 非雅思（entry.ielts !== true） */
type IeltsFilter = "all" | "ielts" | "nonielts";

const POS_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "verb", label: "动词" },
  { value: "noun", label: "名词" },
  { value: "adjective", label: "形容词" },
  { value: "adverb", label: "副词" },
  { value: "other", label: "其他" },
] as const;
type PosOption = (typeof POS_OPTIONS)[number]["value"];

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "recent", label: "最近查询" },
  { value: "count", label: "查询次数" },
  { value: "alpha", label: "字母顺序" },
];

/** 单词本每页展示多少条 —— 太长会让整页滚动很累。 */
const PAGE_SIZE = 10;

interface UndoState {
  lemma: string;
  from: WordbookStatus;
  to: WordbookStatus;
  /** epoch ms when the toast should auto-dismiss */
  expiresAt: number;
}

export default function WordbookPage() {
  // useSearchParams 在 App Router 下必须被 Suspense 包裹，否则
  // `next build` 预渲染阶段会报 "should be wrapped in a suspense boundary"。
  return (
    <Suspense fallback={null}>
      <WordbookPageInner />
    </Suspense>
  );
}

function WordbookPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [entries, setEntries] = useState<WordbookEntry[]>([]);
  const [tab, setTab] = useState<WordbookStatus>("new");
  const [pos, setPos] = useState<PosOption>("all");
  const [purpose, setPurpose] = useState<PurposeFilter>("all");
  const [ielts, setIeltsFilter] = useState<IeltsFilter>("all");
  const [month, setMonth] = useState<string>("all"); // "all" | "YYYY-MM"
  const [sortKey, setSortKey] = useState<SortKey>("recent");
  const [undo, setUndo] = useState<UndoState | null>(null);
  // 当前页码（1-based）。同步到 URL 的 ?page=N，这样从详情页 back 回来时
  // 能回到之前那一页；同时筛选/tab 切换时用 router.replace 把页码夹回 1，
  // 不产生额外的 history 条目。
  const [page, setPage] = useState<number>(() => {
    // 初始化时尽量从 URL 读；SSR 下 searchParams 可能为空。
    const raw = searchParams?.get("page");
    const n = raw ? parseInt(raw, 10) : 1;
    return Number.isFinite(n) && n >= 1 ? n : 1;
  });
  // "听力训练"模式：把 lemma 遮成 •••••，只留朗读按钮可用。
  // A 方案 — 单词区域点击时临时揭示（onPointerDown 揭开、松手/离开恢复），
  // 手滑不会跳转到详情页。
  const [masked, setMasked] = useState(false);
  const [revealedLemma, setRevealedLemma] = useState<string | null>(null);
  // “释义”弹窗当前展示的 lemma；null 表示弹窗关闭。所有行共享同一个 Modal。
  const [defLemma, setDefLemma] = useState<string | null>(null);

  // Seed from localStorage and live-refresh on changes from any source
  // (detail page, sibling tab, etc).
  useEffect(() => {
    function refresh() {
      setEntries(listEntries());
    }
    refresh();
    window.addEventListener("get:wordbook-change", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("get:wordbook-change", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  // Auto-dismiss the undo toast after its window expires. We poll once a
  // second instead of using a single setTimeout so a fresh action that
  // overwrites `undo` doesn't leave a dangling timer firing on the wrong row.
  useEffect(() => {
    if (!undo) return;
    const id = window.setInterval(() => {
      if (Date.now() >= undo.expiresAt) setUndo(null);
    }, 250);
    return () => window.clearInterval(id);
  }, [undo]);

  const counts = useMemo(() => {
    let n = 0;
    let o = 0;
    for (const e of entries) {
      if (e.status === "new") n += 1;
      else if (e.status === "old") o += 1;
    }
    return { new: n, old: o };
  }, [entries]);

  // Build the month dropdown options from whatever lastQueriedAt months the
  // current tab actually contains. Without this we'd offer empty months.
  const monthOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      if (e.status !== tab) continue;
      const ym = monthKey(e.lastQueriedAt ?? e.lastSeenAt);
      if (ym) set.add(ym);
    }
    const sorted = Array.from(set).sort().reverse(); // newest first
    return [
      { value: "all", label: "全部时间" },
      ...sorted.map((ym) => ({ value: ym, label: monthLabel(ym) })),
    ];
  }, [entries, tab]);

  // If switching tabs invalidates the current month selection, drop back to "all".
  useEffect(() => {
    if (month === "all") return;
    if (!monthOptions.some((o) => o.value === month)) setMonth("all");
  }, [month, monthOptions]);

  const visible = useMemo(() => {
    const filtered = entries
      .filter((e) => e.status === tab)
      .filter((e) => matchPos(e.pos, pos))
      .filter((e) => matchPurpose(e.purpose, purpose))
      .filter((e) => matchIelts(e.ielts, ielts))
      .filter((e) => matchMonth(e.lastQueriedAt ?? e.lastSeenAt, month));
    return [...filtered].sort(buildComparator(sortKey));
  }, [entries, tab, pos, purpose, ielts, month, sortKey]);

  // 任何筛选/tab 切换都把页码拽回第 1 页，避免出现
  //   “老朋友 25 条，切到只剩 3 条的 tab 后 page=3 → 空列表” 这种尴尬。
  useEffect(() => {
    setPage(1);
  }, [tab, pos, purpose, ielts, month, sortKey]);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  // 若 visible 变短导致 page 超出（例如把某个词移到别的 tab 后当前页空了），
  // 静默夹回合法区间。effect 里再修一次是为了让 UI 立刻看到新页码。
  const safePage = Math.min(page, totalPages);
  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  // 把 safePage 同步到 URL 的 ?page=N。这样点单词进详情页 → back 回来
  // 时，URL 仍带着正确的页码，重新初始化的 state 会从 URL 读回去，
  // 用户看到的就是之前那一页而不是首页。用 replace 而非 push，
  // 避免在同一页内反复翻页时往 history 里塞一堆条目。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const current = searchParams?.get("page");
    const desired = safePage === 1 ? null : String(safePage);
    // 相同就不动，避免无用的 replace（并且防止 effect 无限循环）。
    if (current === desired) return;
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (desired === null) params.delete("page");
    else params.set("page", desired);
    const qs = params.toString();
    router.replace(qs ? `/wordbook?${qs}` : "/wordbook", { scroll: false });
  }, [safePage, router, searchParams]);

  const paginated = useMemo(
    () => visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [visible, safePage],
  );

  function handleMove(entry: WordbookEntry) {
    const to: WordbookStatus = entry.status === "new" ? "old" : "new";
    setStatus(entry.lemma, to);
    setUndo({
      lemma: entry.lemma,
      from: entry.status,
      to,
      expiresAt: Date.now() + 5000,
    });
  }

  function handleUndo() {
    if (!undo) return;
    setStatus(undo.lemma, undo.from);
    setUndo(null);
  }

  return (
    <div className="space-y-5">
      <header className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <button
              type="button"
              onClick={() => goBack(router)}
              title="返回上一页"
              aria-label="返回上一页"
              className="group inline-flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-full text-[var(--fg-soft)] transition hover:text-[var(--accent)]"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="h-6 w-6"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M14 8l-4 4 4 4" />
                <path d="M10 12h6" />
              </svg>
            </button>
            <h1 className="text-xl font-semibold tracking-tight">单词本</h1>
          </div>
          <span className="text-xs text-[var(--fg-soft)]">
            共 <span className="font-medium text-[var(--fg)]">{visible.length}</span> 个
          </span>
        </div>

        {/* Tabs */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="inline-flex rounded-md border border-[var(--border)] p-0.5">
            {(
              [
                { key: "new", label: `新朋友 · ${counts.new}` },
                { key: "old", label: `老朋友 · ${counts.old}` },
              ] as const
            ).map((it) => {
              const active = tab === it.key;
              return (
                <button
                  key={it.key}
                  type="button"
                  onClick={() => setTab(it.key)}
                  className={[
                    "rounded px-3 py-1 text-sm transition",
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

          {/* 听力训练开关：遮住单词字面，只留朗读按钮。 */}
          <button
            type="button"
            onClick={() => {
              setMasked((v) => !v);
              setRevealedLemma(null);
            }}
            title={masked ? "显示所有单词" : "遮住单词，只听音训练"}
            aria-pressed={masked}
            className={[
              "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition",
              masked
                ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                : "border-[var(--border)] text-[var(--fg-soft)] hover:text-[var(--fg)] hover:border-[var(--fg-soft)]",
            ].join(" ")}
          >
            <span aria-hidden>{masked ? "👁" : "🙈"}</span>
            <span>{masked ? "显示单词" : "听力训练"}</span>
          </button>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {/* 复习方式（听说写 / 阅读）— 专门拉出成一组胶囊按钮，
              方便快速在两类词之间切换。选中项高亮；默认“全部”。 */}
          <div
            className="inline-flex rounded-md border border-[var(--border)] p-0.5"
            role="radiogroup"
            aria-label="复习方式筛选"
          >
            {(
              [
                { key: "all", label: "全部" },
                { key: "active", label: "听说写" },
                { key: "passive", label: "阅读" },
              ] as const
            ).map((it) => {
              const active = it.key === purpose;
              return (
                <button
                  key={it.key}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setPurpose(it.key)}
                  className={[
                    "rounded px-2.5 py-1 transition",
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
          {/* 雅思筛选 — 与 purpose 正交的独立一组胶囊。
              一个单词可以既是雅思又是听说写，所以这里单独一组、不与上面混。 */}
          <div
            className="inline-flex rounded-md border border-[var(--border)] p-0.5"
            role="radiogroup"
            aria-label="雅思筛选"
          >
            {(
              [
                { key: "all", label: "全部" },
                { key: "ielts", label: "仅雅思" },
                { key: "nonielts", label: "非雅思" },
              ] as const
            ).map((it) => {
              const active = it.key === ielts;
              return (
                <button
                  key={it.key}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setIeltsFilter(it.key)}
                  className={[
                    "rounded px-2.5 py-1 transition",
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
          <label className="inline-flex items-center gap-1.5 text-[var(--fg-soft)]">
            词性
            <select
              value={pos}
              onChange={(e) => setPos(e.target.value as PosOption)}
              className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-[var(--fg)] outline-none"
            >
              {POS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-flex items-center gap-1.5 text-[var(--fg-soft)]">
            时间
            <select
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-[var(--fg)] outline-none"
            >
              {monthOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-flex items-center gap-1.5 text-[var(--fg-soft)]">
            排序
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-[var(--fg)] outline-none"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {/* List */}
      {visible.length === 0 ? (
        <p className="text-sm text-[var(--fg-soft)]">
          {tab === "new"
            ? "还没有新朋友。先去查几个生词吧。"
            : "还没有老朋友。完成复习的单词会自动来到这里。"}
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
          {paginated.map((e) => {
            const isNew = e.status === "new";
            const moveTitle =
              isNew ? "已掌握，移到老朋友" : "还想再看，移回新朋友";
            const isRevealed = revealedLemma === e.lemma;
            const showLemma = !masked || isRevealed;
            // 加密态下点单词区不再跳详情页（避免手滑穿帮），
            // 而是"按住揭示"：pointerdown 显示，抬起/离开恢复遮罩。
            const wordAreaProps = masked
              ? {
                  role: "button" as const,
                  tabIndex: 0,
                  title: isRevealed ? "松开恢复遮罩" : "按住可临时查看单词",
                  onPointerDown: () => setRevealedLemma(e.lemma),
                  onPointerUp: () => setRevealedLemma(null),
                  onPointerLeave: () => setRevealedLemma(null),
                  onPointerCancel: () => setRevealedLemma(null),
                  onKeyDown: (ev: React.KeyboardEvent) => {
                    if (ev.key === " " || ev.key === "Enter") {
                      ev.preventDefault();
                      setRevealedLemma(e.lemma);
                    }
                  },
                  onKeyUp: () => setRevealedLemma(null),
                }
              : {};
            return (
              <li key={e.lemma} className="group">
                <div className="flex items-center gap-3 px-4 py-3 transition hover:bg-[var(--bg-soft)]">
                  {/* 朗读按钮：不管加不加密，始终可点。 */}
                  <div
                    className="shrink-0"
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    <SpeakButton
                      text={e.lemma}
                      variant="us"
                      title={masked ? "朗读（听音辨词）" : `朗读 ${e.lemma}`}
                    />
                  </div>

                  {masked ? (
                    <div
                      {...wordAreaProps}
                      className="flex min-w-0 flex-1 cursor-pointer items-baseline justify-between gap-3 select-none"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span
                            className={
                              showLemma
                                ? "font-medium"
                                : "font-medium tracking-[0.15em] text-[var(--fg-soft)]"
                            }
                          >
                            {showLemma ? e.lemma : maskLemma(e.lemma)}
                          </span>
                          {e.pos && (
                            <span className="rounded bg-[var(--bg-soft)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--fg-soft)]">
                              {shortPos(e.pos)}
                            </span>
                          )}
                          {e.ielts && (
                            <span
                              title="雅思学习词汇"
                              className="rounded bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-[var(--accent)]"
                            >
                              雅思
                            </span>
                          )}
                        </div>
                        {/* 雅思核心例句 — 听力训练模式下需隐藏（否则例句会直接逢穿单词）。
                            未揭示时直接不渲染；揭示时才展。 */}
                        {e.ielts && e.coreExample && showLemma && (
                          <div
                            className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[var(--fg-soft)]"
                            title={e.coreExample}
                          >
                            {e.coreExample}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 space-x-3 text-xs text-[var(--fg-soft)]">
                        <span title="查询次数">×{e.queryCount}</span>
                        <span title="最近查询日期">
                          {formatQueryDate(e.lastQueriedAt ?? e.lastSeenAt)}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <Link
                      href={`/word/${encodeURIComponent(e.lemma)}?from=wordbook`}
                      className="flex min-w-0 flex-1 items-baseline justify-between gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="font-medium">{e.lemma}</span>
                          {e.pos && (
                            <span className="rounded bg-[var(--bg-soft)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--fg-soft)]">
                              {shortPos(e.pos)}
                            </span>
                          )}
                          {e.ielts && (
                            <span
                              title="雅思学习词汇"
                              className="rounded bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-[var(--accent)]"
                            >
                              雅思
                            </span>
                          )}
                        </div>
                        {e.ielts && e.coreExample && (
                          <div
                            className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[var(--fg-soft)]"
                            title={e.coreExample}
                          >
                            {e.coreExample}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 space-x-3 text-xs text-[var(--fg-soft)]">
                        <span title="查询次数">×{e.queryCount}</span>
                        <span title="最近查询日期">
                          {formatQueryDate(e.lastQueriedAt ?? e.lastSeenAt)}
                        </span>
                      </div>
                    </Link>
                  )}
                  <button
                    type="button"
                    title="查看释义"
                    aria-label={`查看 ${e.lemma} 的释义`}
                    onClick={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      setDefLemma(e.lemma);
                    }}
                    className="shrink-0 rounded-full border border-[var(--border)] bg-transparent px-2 py-0.5 text-[11px] text-[var(--fg-soft)] transition hover:border-[var(--accent)] hover:text-[var(--accent)] active:scale-95"
                  >
                    释义
                  </button>
                  <button
                    type="button"
                    title={moveTitle}
                    aria-label={moveTitle}
                    onClick={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      handleMove(e);
                    }}
                    className="shrink-0 rounded-md p-0.5 leading-none transition hover:opacity-70"
                  >
                    {isNew ? (
                      <Image
                        src="/get-check.png"
                        alt="标记为已掌握"
                        width={56}
                        height={56}
                        className="h-10 w-10 object-contain"
                      />
                    ) : (
                      <Image
                        src="/lost-mark.png"
                        alt="标记为未掌握"
                        width={56}
                        height={56}
                        className="h-10 w-10 object-contain"
                      />
                    )}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* 分页控件 —— 只有单页时不显示，免得视觉噪音。 */}
      {visible.length > 0 && totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-1">
          <button
            type="button"
            disabled={safePage === 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            aria-label="上一页"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border)] bg-transparent text-sm text-[var(--fg-soft)] transition hover:text-[var(--fg)] hover:border-[var(--fg-soft)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ‹
          </button>
          <span className="text-xs text-[var(--fg-soft)] tabular-nums">
            {safePage} / {totalPages}
          </span>
          <button
            type="button"
            disabled={safePage === totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            aria-label="下一页"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border)] bg-transparent text-sm text-[var(--fg-soft)] transition hover:text-[var(--fg)] hover:border-[var(--fg-soft)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ›
          </button>
        </div>
      )}

      {/* Undo toast */}
      {undo && (
        <div
          role="status"
          className="fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
        >
          <div className="flex items-center gap-3 rounded-full border border-[var(--border)] bg-[var(--bg)] px-4 py-2 text-sm shadow-lg">
            <span>
              已将 <span className="font-medium">{undo.lemma}</span> 移到
              {undo.to === "old" ? "「老朋友」" : "「新朋友」"}
            </span>
            <button
              type="button"
              onClick={handleUndo}
              className="text-[var(--accent)] hover:underline"
            >
              撤销
            </button>
          </div>
        </div>
      )}

      {/* 释义弹窗 — 所有行共用，由 defLemma 驱动开合。 */}
      <DefinitionModal lemma={defLemma} onClose={() => setDefLemma(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Navigate to the previous page. Falls back to the home surface when there
 * is no in-app history (e.g. the user landed on /wordbook via a bookmark or
 * an external share link) — otherwise router.back() would drop them out of
 * the site entirely.
 */
function goBack(router: ReturnType<typeof useRouter>) {
  if (typeof window !== "undefined" && window.history.length > 1) {
    router.back();
  } else {
    router.push("/");
  }
}

function matchPos(stored: string | undefined, want: PosOption): boolean {
  if (want === "all") return true;
  const s = (stored ?? "").toLowerCase();
  if (want === "other") {
    return !["verb", "noun", "adjective", "adverb"].some((p) => s.includes(p));
  }
  return s.includes(want);
}

/** “all” 匹配全部；否则严格比对 purpose，未设置时视为 “active”（与其他代码一致）。 */
function matchPurpose(
  stored: WordbookPurpose | undefined,
  want: PurposeFilter,
): boolean {
  if (want === "all") return true;
  const actual: WordbookPurpose = stored ?? "active";
  return actual === want;
}

/** 雅思筛选：all 全中；ielts 仅保留 flag 为 true；nonielts 仅保留 flag 不为 true。
 *  undefined 视同 false，保证历史存量自然归入“非雅思”。 */
function matchIelts(
  stored: boolean | undefined,
  want: IeltsFilter,
): boolean {
  if (want === "all") return true;
  const isIelts = stored === true;
  return want === "ielts" ? isIelts : !isIelts;
}

/** Returns "YYYY-MM" for the given ISO timestamp, or null if unparseable. */
function monthKey(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  return `${y}年${m}月`;
}

function matchMonth(iso: string | undefined, want: string): boolean {
  if (want === "all") return true;
  return monthKey(iso) === want;
}

function buildComparator(key: SortKey) {
  switch (key) {
    case "recent":
      // Sort by lastQueriedAt (the field the date column displays); fall
      // back to lastSeenAt for legacy rows that never carried a query date.
      return (a: WordbookEntry, b: WordbookEntry) => {
        const av = a.lastQueriedAt ?? a.lastSeenAt;
        const bv = b.lastQueriedAt ?? b.lastSeenAt;
        return av < bv ? 1 : -1;
      };
    case "count":
      return (a: WordbookEntry, b: WordbookEntry) => {
        if (a.queryCount !== b.queryCount) return b.queryCount - a.queryCount;
        return a.lemma < b.lemma ? -1 : 1;
      };
    case "alpha":
      return (a: WordbookEntry, b: WordbookEntry) =>
        a.lemma < b.lemma ? -1 : 1;
  }
}

function shortPos(pos: string): string {
  const lc = pos.toLowerCase();
  if (lc.includes("verb")) return "v.";
  if (lc.includes("noun")) return "n.";
  if (lc.includes("adverb")) return "adv.";
  if (lc.includes("adjective")) return "adj.";
  if (lc.includes("preposition")) return "prep.";
  if (lc.includes("conjunction")) return "conj.";
  if (lc.includes("pronoun")) return "pron.";
  return pos.slice(0, 5);
}

/**
 * 把 lemma 遮成同长度的圆点串。保留字母数量作为微弱视觉线索，
 * 但既不透露首字母也不透露拼写。空格 / 连字符原样保留，避免
 * 词组类的条目变成一坨点看不出结构。
 */
function maskLemma(lemma: string): string {
  return lemma
    .split("")
    .map((ch) => (/[a-zA-Z]/.test(ch) ? "•" : ch))
    .join("");
}

/** Show absolute month/day for the current year, year-prefixed otherwise. */
function formatQueryDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  if (d.getFullYear() === new Date().getFullYear()) {
    return `${m}/${day}`;
  }
  return `${d.getFullYear()}/${m}/${day}`;
}
