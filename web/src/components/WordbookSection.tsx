"use client";

import Image from "next/image";
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
    <div className="relative overflow-hidden rounded-[var(--radius-lg)] border border-white/80 bg-[var(--card)] shadow-[var(--shadow-md)] h-full flex flex-col">
      {/* subtle top accent line for hierarchy */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[var(--accent)]/25 to-transparent" />

      <header className="px-5 pt-5 pb-3 shrink-0">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-baseline gap-2.5">
            <h2 className="text-[19px] leading-none font-semibold tracking-tight">单词本</h2>
            <span className="text-[12px] text-[var(--fg-soft)] tabular-nums">
              共 <span className="text-[var(--fg)] font-medium">{visible.length}</span> 个
            </span>
          </div>
          <div className="inline-flex rounded-full border border-[var(--border)]/70 bg-[var(--bg-soft)]/60 p-0.5 whitespace-nowrap">
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
                    "rounded-full px-3 py-1 text-[12px] font-medium transition whitespace-nowrap",
                    active
                      ? "bg-white text-[var(--fg)] shadow-[0_2px_6px_rgba(52,92,112,0.10)]"
                      : "text-[var(--fg-soft)] hover:text-[var(--fg)]",
                  ].join(" ")}
                >
                  {it.label}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <div className="px-5 pb-3 shrink-0 flex items-center justify-end gap-1.5 whitespace-nowrap">
        {[
          { value: pos, options: POS_OPTIONS, on: (v: string) => setPos(v as PosOption), title: "词性" },
          { value: month, options: monthOptions, on: (v: string) => setMonth(v), title: "时间" },
          { value: sortKey, options: SORT_OPTIONS, on: (v: string) => setSortKey(v as SortKey), title: "排序" },
        ].map((sel, idx) => (
          <select
            key={idx}
            value={sel.value}
            onChange={(e) => sel.on(e.target.value)}
            title={sel.title}
            className="rounded-full border border-[var(--border)]/60 bg-white/80 px-2.5 py-1 text-[11px] text-[var(--fg-soft)] outline-none transition hover:border-[var(--accent)]/50 hover:text-[var(--fg)] cursor-pointer"
          >
            {sel.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ))}
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
            <ul className="flex-1 overflow-hidden flex flex-col gap-2">
              {paginated.map((e) => {
                const isNew = e.status === "new";
                const moveTitle = isNew
                  ? "已掌握，移到老朋友"
                  : "还想再看，移回新朋友";
                const stripColor = isNew
                  ? "var(--new-friend)"
                  : "var(--old-friend)";
                return (
                  <li key={e.lemma} className="group flex-1 flex flex-col justify-center">
                    <div
                      className="relative overflow-hidden rounded-[var(--radius-md)] border border-black/[0.06] bg-white pl-4 pr-4 py-2 shadow-[var(--shadow-sm)] transition-all duration-200 hover:-translate-y-[1px] hover:shadow-[var(--shadow-md)] hover:border-black/[0.09]"
                    >
                      {/* left color strip — quiet status marker */}
                      <span
                        aria-hidden
                        className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full opacity-70"
                        style={{ background: stripColor }}
                      />
                      <div className="flex items-center gap-3">
                        <Link
                          href={`/word/${encodeURIComponent(e.lemma)}?from=wordbook`}
                          className="flex min-w-0 flex-1 items-baseline justify-between gap-3"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-2">
                              <span className="truncate text-[16px] leading-[1.25] pb-[2px] font-medium tracking-tight">
                                {e.lemma}
                              </span>
                              {e.pos && (
                                <span className="rounded-full bg-[var(--bg-soft)]/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--fg-soft)]">
                                  {shortPos(e.pos)}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="shrink-0 flex items-center gap-3 text-[11px] text-[var(--fg-soft)] tabular-nums">
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
                          className="shrink-0 rounded-md p-0.5 leading-none transition hover:opacity-70 active:scale-95"
                        >
                          {isNew ? (
                            <Image
                              src="/get-check.png"
                              alt="标记为已掌握"
                              width={48}
                              height={48}
                              className="h-8 w-8 object-contain"
                            />
                          ) : (
                            <Image
                              src="/lost-mark.png"
                              alt="标记为未掌握"
                              width={48}
                              height={48}
                              className="h-8 w-8 object-contain"
                            />
                          )}
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
              {Array.from({ length: PAGE_SIZE - paginated.length }).map((_, i) => (
                <li key={`empty-${i}`} className="flex-1 flex flex-col justify-center pointer-events-none">
                  <div className="px-4 py-2 opacity-0">
                    <div className="h-6"></div>
                  </div>
                </li>
              ))}
            </ul>

            <div className="flex items-center justify-center gap-2 pt-2 pb-0.5 shrink-0">
              <button
                type="button"
                disabled={page === 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-label="上一页"
                className="w-6 h-6 flex items-center justify-center text-xs rounded-full border border-[var(--border)]/70 bg-white/70 text-[var(--fg-soft)] disabled:opacity-40 hover:bg-white hover:text-[var(--fg)] transition leading-none"
              >
                ‹
              </button>
              <span className="text-[11px] text-[var(--fg-soft)] tabular-nums">
                {page}/{totalPages}
              </span>
              <button
                type="button"
                disabled={page === totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                aria-label="下一页"
                className="w-6 h-6 flex items-center justify-center text-xs rounded-full border border-[var(--border)]/70 bg-white/70 text-[var(--fg-soft)] disabled:opacity-40 hover:bg-white hover:text-[var(--fg)] transition leading-none"
              >
                ›
              </button>
            </div>
          </>
        )}
      </div>

      {undo && (
        <div
          role="status"
          className="fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
        >
          <div className="flex items-center gap-3 rounded-full border border-[var(--border)] bg-[var(--card)] px-4 py-2 text-sm shadow-lg">
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

      {/* Dinosaur decoration in bottom-right corner */}
      <Image
        src="/decor/peek-dino.png"
        alt=""
        aria-hidden
        width={220}
        height={110}
        className="absolute bottom-2 right-2 w-[100px] h-auto opacity-60 pointer-events-none select-none"
        priority={false}
      />
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
    return `${m}/${day}`;
  }
  return `${d.getFullYear()}/${m}/${day}`;
}
