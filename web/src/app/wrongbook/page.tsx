"use client";

/**
 * /wrongbook — 错词本。
 *
 * 数据源：`entry.inWrongBook === true` 的所有词条（与错误累计次数 errorCount 独立）。
 * UI 与 /wordbook 高度一致（Tab、筛选、卡片布局、朗读/移除、释义弹窗），
 * 顶部额外加一个「重温错词」按钮，跳转到 /review?mode=wrongbook。
 *
 * 关键交互差异：
 *   - 没有「新朋友 / 老朋友」Tab 切换：错词本里的词都是「当前错了的」，
 *     一旦重温正确会自动移除。
 *   - 排序默认按「错误次数（由高到低）」，因为用户来错词本就是为了先攻克错得多的。
 *   - 卡片上的「✅」按钮 = 手动从错词本移除（inWrongBook=false，errorCount 不变）。
 */

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  listEntries,
  readStore,
  writeStore,
  type WordbookEntry,
  type WordbookPurpose,
} from "@/lib/wordbook/local";
import SpeakButton from "@/components/SpeakButton";
import DefinitionModal from "@/components/DefinitionModal";

type SortKey = "error" | "recent" | "count" | "alpha";
type PurposeFilter = "all" | WordbookPurpose;
type IeltsFilter = "all" | "ielts" | "nonielts";

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "error", label: "错误次数" },
  { value: "recent", label: "最近查询" },
  { value: "count", label: "查询次数" },
  { value: "alpha", label: "字母顺序" },
];

const PAGE_SIZE = 10;

export default function WrongbookPage() {
  const router = useRouter();
  const [entries, setEntries] = useState<WordbookEntry[]>([]);
  const [purpose, setPurpose] = useState<PurposeFilter>("all");
  const [ielts, setIeltsFilter] = useState<IeltsFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("error");
  const [page, setPage] = useState(1);
  const [defLemma, setDefLemma] = useState<string | null>(null);

  useEffect(() => {
    function refresh() {
      // 全量读，但只保留 inWrongBook === true 的（可能包括 archived 或
      // old friend 状态：错过的老朋友仍应保留在错词本，直到重温回归正确）。
      const all = listEntries({ includeArchived: true }).filter(
        (e) => e.inWrongBook === true,
      );
      setEntries(all);
    }
    refresh();
    window.addEventListener("get:wordbook-change", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("get:wordbook-change", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const visible = useMemo(() => {
    const filtered = entries
      .filter((e) => matchPurpose(e.purpose, purpose))
      .filter((e) => matchIelts(e.ielts, ielts));
    return [...filtered].sort(buildComparator(sortKey));
  }, [entries, purpose, ielts, sortKey]);

  useEffect(() => setPage(1), [purpose, ielts, sortKey]);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);
  const paginated = useMemo(
    () => visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [visible, safePage],
  );

  /**
   * 手动从错词本移除某个词：inWrongBook 置 false，errorCount 保持不变
   * （历史错误次数是不可变的记忆）。
   */
  function handleRemove(lemma: string) {
    const store = readStore();
    const key = lemma.toLowerCase().trim();
    const e = store[key];
    if (!e) return;
    store[key] = { ...e, inWrongBook: false };
    writeStore(store);
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
            <h1 className="text-xl font-semibold tracking-tight">错词本</h1>
          </div>
          <span className="text-xs text-[var(--fg-soft)]">
            共{" "}
            <span className="font-medium text-[var(--fg)]">
              {visible.length}
            </span>{" "}
            个
          </span>
        </div>

        {/* 重温错词 —— 主要行动 */}
        <div>
          <Link
            href="/review?mode=wrongbook"
            className={[
              "inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold transition",
              entries.length > 0
                ? "bg-[var(--accent)] text-white shadow-[0_6px_14px_rgba(106,167,195,0.35)] hover:brightness-105"
                : "cursor-not-allowed border border-[var(--border)] bg-white/70 opacity-55",
            ].join(" ")}
            aria-disabled={entries.length === 0}
            onClick={(e) => {
              if (entries.length === 0) e.preventDefault();
            }}
          >
            重温错词
          </Link>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 text-xs">
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
          错词本目前是空的。复习过程中答错的词会自动进入这里。
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
          {paginated.map((e) => (
            <li key={e.lemma} className="group">
              <div className="flex items-center gap-3 px-4 py-3 transition hover:bg-[var(--bg-soft)]">
                <div
                  className="shrink-0"
                  onClick={(ev) => ev.stopPropagation()}
                >
                  <SpeakButton
                    text={e.lemma}
                    variant="us"
                    title={`朗读 ${e.lemma}`}
                  />
                </div>
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
                      <span
                        title="累计错误次数"
                        className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-red-500"
                      >
                        错 × {e.errorCount ?? 0}
                      </span>
                    </div>
                    {e.coreExample && (
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
                  title="已掌握，从错词本移除"
                  aria-label={`将 ${e.lemma} 从错词本移除`}
                  onClick={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    handleRemove(e.lemma);
                  }}
                  className="shrink-0 rounded-md p-0.5 leading-none transition hover:opacity-70"
                >
                  <Image
                    src="/get-check.png"
                    alt="已掌握"
                    width={56}
                    height={56}
                    className="h-10 w-10 object-contain"
                  />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

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

      <DefinitionModal lemma={defLemma} onClose={() => setDefLemma(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function goBack(router: ReturnType<typeof useRouter>) {
  if (typeof window !== "undefined" && window.history.length > 1) {
    router.back();
  } else {
    router.push("/");
  }
}

function matchPurpose(
  stored: WordbookPurpose | undefined,
  want: PurposeFilter,
): boolean {
  if (want === "all") return true;
  const actual: WordbookPurpose = stored ?? "active";
  return actual === want;
}

function matchIelts(stored: boolean | undefined, want: IeltsFilter): boolean {
  if (want === "all") return true;
  const isIelts = stored === true;
  return want === "ielts" ? isIelts : !isIelts;
}

function buildComparator(key: SortKey) {
  switch (key) {
    case "error":
      return (a: WordbookEntry, b: WordbookEntry) => {
        const ae = a.errorCount ?? 0;
        const be = b.errorCount ?? 0;
        if (ae !== be) return be - ae;
        return a.lemma < b.lemma ? -1 : 1;
      };
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
