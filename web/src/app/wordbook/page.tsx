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
import { useRouter } from "next/navigation";
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
  /** epoch ms when the toast should auto-dismiss */
  expiresAt: number;
}

export default function WordbookPage() {
  const router = useRouter();
  const [entries, setEntries] = useState<WordbookEntry[]>([]);
  const [tab, setTab] = useState<WordbookStatus>("new");
  const [pos, setPos] = useState<PosOption>("all");
  const [month, setMonth] = useState<string>("all"); // "all" | "YYYY-MM"
  const [sortKey, setSortKey] = useState<SortKey>("recent");
  const [undo, setUndo] = useState<UndoState | null>(null);

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
      .filter((e) => matchMonth(e.lastQueriedAt ?? e.lastSeenAt, month));
    return [...filtered].sort(buildComparator(sortKey));
  }, [entries, tab, pos, month, sortKey]);

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
              className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--fg-soft)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              ← 返回
            </button>
            <h1 className="text-xl font-semibold tracking-tight">单词本</h1>
          </div>
          <span className="text-xs text-[var(--fg-soft)]">
            共 <span className="font-medium text-[var(--fg)]">{visible.length}</span> 个
          </span>
        </div>

        {/* Tabs */}
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

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 text-xs">
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
          {visible.map((e) => {
            const isNew = e.status === "new";
            const moveTitle =
              isNew ? "已掌握，移到老朋友" : "还想再看，移回新朋友";
            return (
              <li key={e.lemma} className="group">
                <div className="flex items-center gap-3 px-4 py-3 transition hover:bg-[var(--bg-soft)]">
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
