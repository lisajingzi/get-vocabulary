"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  listEntries,
  setStatus,
  type WordbookEntry,
  type WordbookStatus,
} from "@/lib/wordbook/local";

type SortKey = "recent" | "count" | "alpha";

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

interface UndoState {
  lemma: string;
  from: WordbookStatus;
  to: WordbookStatus;
  expiresAt: number;
}

const PAGE_SIZE = 5;

export default function WordbookSection() {
  const [entries, setEntries] = useState<WordbookEntry[]>([]);
  const [tab, setTab] = useState<WordbookStatus>("new");
  const [pos, setPos] = useState<PosOption>("all");
  const [month, setMonth] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("recent");
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [page, setPage] = useState(1);

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

  const monthOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      if (e.status !== tab) continue;
      const ym = monthKey(e.lastQueriedAt ?? e.lastSeenAt);
      if (ym) set.add(ym);
    }
    const sorted = Array.from(set).sort().reverse();
    return [
      { value: "all", label: "全部时间" },
      ...sorted.map((ym) => ({ value: ym, label: monthLabel(ym) })),
    ];
  }, [entries, tab]);

  useEffect(() => {
    if (month === "all") return;
    if (!monthOptions.some((o) => o.value === month)) setMonth("all");
  }, [month, monthOptions]);

  const visible = useMemo(() => {
    const filtered = entries
      .filter((e) => e.status === tab)
      .filter((e) => matchPos(e.pos, pos))
      .filter((e) => matchMonth(e.lastQueriedAt ?? e.lastSeenAt, month));
    return [...filtered].sort(buildComparator(sortKey));
  }, [entries, tab, pos, month, sortKey]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [tab, pos, month, sortKey]);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const paginated = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

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
    <div className="rounded-2xl border border-[var(--border)] overflow-hidden flex flex-col bg-[var(--bg)] shadow-sm h-full">
      {/* 标题区 - 与打卡模块的月份头部风格一致，留出充足留白 */}
      <header className="px-5 pt-5 pb-3 shrink-0">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight">单词本</h2>
          <span className="text-xs text-[var(--fg-soft)]">
            共 <span className="font-medium text-[var(--fg)]">{visible.length}</span> 个
          </span>
        </div>
      </header>

      {/* Tabs（左）+ 筛选项（右）一行 - 两者功能不同，分开对齐 */}
      <div className="px-5 pb-3 shrink-0 flex items-center justify-between gap-2 flex-wrap">
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
                  "rounded px-2 py-0.5 text-xs transition",
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

        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <select
            value={pos}
            onChange={(e) => setPos(e.target.value as PosOption)}
            className="rounded-md border border-[var(--border)] bg-transparent px-1.5 py-0.5 text-[var(--fg-soft)] outline-none"
            title="词性"
          >
            {POS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-transparent px-1.5 py-0.5 text-[var(--fg-soft)] outline-none"
            title="时间"
          >
            {monthOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="rounded-md border border-[var(--border)] bg-transparent px-1.5 py-0.5 text-[var(--fg-soft)] outline-none"
            title="排序"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col px-5 pb-5">
        {visible.length === 0 ? (
          <p className="text-sm text-[var(--fg-soft)] py-4">
            {tab === "new"
              ? "还没有新朋友。先去查几个生词吧。"
              : "还没有老朋友。完成复习的单词会自动来到这里。"}
          </p>
        ) : (
          <>
            <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] flex-1 overflow-hidden flex flex-col">
              {paginated.map((e) => {
                const moveIcon = e.status === "new" ? "✅" : "🧐";
                const moveTitle =
                  e.status === "new" ? "已掌握，移到老朋友" : "还想再看，移回新朋友";
                return (
                  <li key={e.lemma} className="group flex-1 flex flex-col justify-center">
                    <div className="flex items-center gap-3 px-4 py-2 transition hover:bg-[var(--bg-soft)]">
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
                          </div>
                        </div>
                        <div className="shrink-0 space-x-3 text-xs text-[var(--fg-soft)]">
                          <span title="查询次数">×{e.queryCount}</span>
                          <span title="最近查询日期">
                            {formatQueryDate(e.lastQueriedAt ?? e.lastSeenAt)}
                          </span>
                        </div>
                      </Link>
                      <button
                        type="button"
                        title={moveTitle}
                        aria-label={moveTitle}
                        onClick={(ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          handleMove(e);
                        }}
                        className="shrink-0 rounded-md border border-transparent px-2 py-1 text-base leading-none transition hover:border-[var(--border)] hover:bg-[var(--bg)]"
                      >
                        {moveIcon}
                      </button>
                    </div>
                  </li>
                );
              })}
              {/* Fill empty space if less than PAGE_SIZE items */}
              {Array.from({ length: PAGE_SIZE - paginated.length }).map((_, i) => (
                <li key={`empty-${i}`} className="flex-1 flex flex-col justify-center pointer-events-none">
                  <div className="px-4 py-2 opacity-0">
                    <div className="h-6"></div>
                  </div>
                </li>
              ))}
            </ul>
            
            {/* Pagination - 整体缩小，去掉文字改为箭头 */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-2 pb-0.5 shrink-0">
                <button
                  type="button"
                  disabled={page === 1}
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  aria-label="上一页"
                  className="w-6 h-6 flex items-center justify-center text-xs rounded border border-[var(--border)] disabled:opacity-40 hover:bg-[var(--bg-soft)] transition leading-none"
                >
                  ‹
                </button>
                <span className="text-[11px] text-[var(--fg-soft)] tabular-nums">
                  {page}/{totalPages}
                </span>
                <button
                  type="button"
                  disabled={page === totalPages}
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  aria-label="下一页"
                  className="w-6 h-6 flex items-center justify-center text-xs rounded border border-[var(--border)] disabled:opacity-40 hover:bg-[var(--bg-soft)] transition leading-none"
                >
                  ›
                </button>
              </div>
            )}
          </>
        )}
      </div>

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
    </div>
  );
}

function matchPos(stored: string | undefined, want: PosOption): boolean {
  if (want === "all") return true;
  const s = (stored ?? "").toLowerCase();
  if (want === "other") {
    return !["verb", "noun", "adjective", "adverb"].some((p) => s.includes(p));
  }
  return s.includes(want);
}

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

function formatQueryDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  if (d.getFullYear() === new Date().getFullYear()) {
    return `${m}月${day}日`;
  }
  return `${d.getFullYear()}年${m}月${day}日`;
}
