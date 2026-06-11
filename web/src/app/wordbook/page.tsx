"use client";

/**
 * /wordbook — personal wordbook page.
 *
 * Two top-level tabs (新朋友 / 老朋友). Below them, two filters that work
 * independently per tab:
 *   - Part-of-speech filter (verb / noun / adjective / adverb / 全部 / 其他)
 *     — uses the `pos` snapshot we stamped onto each entry at first lookup.
 *   - Sort selector:
 *       recent      最近查询时间 desc  (default)
 *       count       查询次数      desc
 *       alpha       字母顺序     asc
 *
 * All state is local to the page; no URL params yet (we can lift if/when the
 * mobile back-stack matters).
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  listEntries,
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

export default function WordbookPage() {
  const [entries, setEntries] = useState<WordbookEntry[]>([]);
  const [tab, setTab] = useState<WordbookStatus>("new");
  const [pos, setPos] = useState<PosOption>("all");
  const [sortKey, setSortKey] = useState<SortKey>("recent");

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

  const counts = useMemo(() => {
    let n = 0;
    let o = 0;
    for (const e of entries) {
      if (e.status === "new") n += 1;
      else o += 1;
    }
    return { new: n, old: o };
  }, [entries]);

  const visible = useMemo(() => {
    const filtered = entries
      .filter((e) => e.status === tab)
      .filter((e) => matchPos(e.pos, pos));
    return [...filtered].sort(buildComparator(sortKey));
  }, [entries, tab, pos, sortKey]);

  return (
    <div className="space-y-5">
      <header className="space-y-3">
        <h1 className="text-xl font-semibold tracking-tight">单词本</h1>

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
          {visible.map((e) => (
            <li key={e.lemma}>
              <Link
                href={`/word/${encodeURIComponent(e.lemma)}`}
                className="flex items-baseline justify-between gap-3 px-4 py-3 transition hover:bg-[var(--bg-soft)]"
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
                  <span title="最近查询">{relativeTime(e.lastSeenAt)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function matchPos(stored: string | undefined, want: PosOption): boolean {
  if (want === "all") return true;
  const s = (stored ?? "").toLowerCase();
  if (want === "other") {
    return !["verb", "noun", "adjective", "adverb"].some((p) => s.includes(p));
  }
  // The dict labels can be "verb", "transitive verb", "noun", "noun [U]" etc.
  return s.includes(want);
}

function buildComparator(key: SortKey) {
  switch (key) {
    case "recent":
      return (a: WordbookEntry, b: WordbookEntry) =>
        a.lastSeenAt < b.lastSeenAt ? 1 : -1;
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

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.max(0, Math.round((now - then) / 1000));
  if (sec < 60) return "刚刚";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} 天前`;
  // Long ago: just show the date.
  return new Date(iso).toLocaleDateString("zh-CN");
}
