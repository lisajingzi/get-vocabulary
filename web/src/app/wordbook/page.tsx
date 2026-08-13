"use client";

/**
 * /wordbook — personal wordbook page.
 *
 * Filters, tab, and page-number are ALL synchronized to the URL search
 * params so that clicking a word → detail → back returns you to the exact
 * same list state you left (Next's App Router only preserves scroll, not
 * component state, so URL is the only reliable channel here).
 */

import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  listEntries,
  setStatus,
  toggleStar,
  type WordbookEntry,
  type WordbookPurpose,
  type WordbookStatus,
} from "@/lib/wordbook/local";
import SpeakButton from "@/components/SpeakButton";
import DefinitionModal from "@/components/DefinitionModal";
import WordAutoPlayer from "@/components/WordAutoPlayer";

type SortKey = "recent" | "count" | "alpha" | "error";
type PurposeFilter = "all" | WordbookPurpose;
type IeltsFilter = "all" | "ielts" | "nonielts";
/** "all" = 不按雅思组名筛；具体字符串代表一个已存在的雅思导入组名。 */
type GroupFilter = "all" | string;

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "recent", label: "最近查询" },
  { value: "count", label: "查询次数" },
  { value: "alpha", label: "字母顺序" },
  { value: "error", label: "错误次数" },
];

const PAGE_SIZE = 10;

interface UndoState {
  lemma: string;
  from: WordbookStatus;
  to: WordbookStatus;
  expiresAt: number;
}

export default function WordbookPage() {
  return (
    <Suspense fallback={null}>
      <WordbookPageInner />
    </Suspense>
  );
}

/** URL param helpers — keep the source of truth in the URL so back/forward
 *  navigation restores the exact same filtered view. */
function parseTab(v: string | null | undefined): WordbookStatus {
  return v === "old" ? "old" : "new";
}
function parsePurpose(v: string | null | undefined): PurposeFilter {
  return v === "active" || v === "passive" ? v : "all";
}
function parseIelts(v: string | null | undefined): IeltsFilter {
  return v === "ielts" || v === "nonielts" ? v : "all";
}
function parseGroup(v: string | null | undefined): GroupFilter {
  const s = (v ?? "").trim();
  return s === "" ? "all" : s;
}
function parseStarred(v: string | null | undefined): boolean {
  return v === "1" || v === "true";
}
function parseSort(v: string | null | undefined): SortKey {
  return v === "count" || v === "alpha" || v === "error" || v === "recent"
    ? v
    : "recent";
}
function parsePage(v: string | null | undefined): number {
  const n = v ? parseInt(v, 10) : 1;
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function WordbookPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [entries, setEntries] = useState<WordbookEntry[]>([]);

  // Filter state is *derived* from the URL, not held as duplicated component
  // state. `router.replace` updates the URL → this component re-renders with
  // new values. That means back/forward navigation restores the view for
  // free — no useEffect gymnastics required.
  const tab = parseTab(searchParams?.get("tab"));
  const purpose = parsePurpose(searchParams?.get("purpose"));
  const ielts = parseIelts(searchParams?.get("ielts"));
  const group = parseGroup(searchParams?.get("group"));
  const starredOnly = parseStarred(searchParams?.get("starred"));
  const sortKey = parseSort(searchParams?.get("sort"));
  const page = parsePage(searchParams?.get("page"));

  const [undo, setUndo] = useState<UndoState | null>(null);
  const [masked, setMasked] = useState(false);
  const [revealedLemma, setRevealedLemma] = useState<string | null>(null);
  const [defLemma, setDefLemma] = useState<string | null>(null);
  // 自动连播当前高亮的单词——仅为行背景色标识，不干预其它交互。
  const [playingLemma, setPlayingLemma] = useState<string | null>(null);

  // Seed from IndexedDB and live-refresh on changes from any source
  // (detail page, sibling tab, etc).
  //
  // 数据源是 IndexedDB，不是 localStorage，所以跨标签页的写入不会
  // 自动触发 "storage" 事件。为了配合"详情页在新标签页打开"的交互
  // （点单词 → 新标签页看/改 → 切回列表），我们额外监听 focus 和
  // visibilitychange：只要这个标签页重新可见/得到焦点，就重跑
  // listEntries()。注意这里只替换 entries state，组件不会重挂载，
  // page / tab / 筛选 / 滚动位置全部原样保留——用户只会看到 star、
  // 是否被删除、分组计数悄悄同步，不会被踢回第一页。
  useEffect(() => {
    function refresh() {
      setEntries(listEntries());
    }
    function refreshIfVisible() {
      if (document.visibilityState === "visible") refresh();
    }
    refresh();
    window.addEventListener("get:wordbook-change", refresh);
    window.addEventListener("storage", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.removeEventListener("get:wordbook-change", refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, []);

  // ─────────────────────────────────────────────────────────────────
  // Back-to-list state preservation (SESSION-SCOPED)
  //
  // Problem: Next.js App Router's Router Cache can serve a stale RSC payload
  // for /wordbook on router.back(), which strips the search params we set
  // via router.replace(). Result: user paginates to page 3, opens a word,
  // hits back — and lands on page 1 with filters cleared.
  //
  // Fix: mirror the URL's querystring into sessionStorage on every change.
  // On mount, if the URL is "bare" (no querystring) but we have a saved one
  // from this tab session, immediately router.replace() it back. This is a
  // last-line-of-defense that works regardless of Next's internal caching.
  //
  // Scope: sessionStorage → dies with the tab, so a fresh window still opens
  // the default (new-friend, page 1) view. ✅
  // ─────────────────────────────────────────────────────────────────
  const KEY_LAST_QS = "wordbook:last-qs";

  // Save current URL state on every change.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const qs = searchParams?.toString() ?? "";
    try {
      window.sessionStorage.setItem(KEY_LAST_QS, qs);
    } catch {
      // Storage might be full / disabled in private mode — silently ignore;
      // worst case we just lose the "return to previous filter" enhancement.
    }
  }, [searchParams]);

  // On first mount, if URL is bare but we have a saved qs, restore it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const currentQs = searchParams?.toString() ?? "";
    if (currentQs) return; // URL already carries state — nothing to do.
    let saved = "";
    try {
      saved = window.sessionStorage.getItem(KEY_LAST_QS) ?? "";
    } catch {
      return;
    }
    if (!saved) return;
    // Use replace so the "bare" entry doesn't linger in history.
    router.replace(`/wordbook?${saved}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const visible = useMemo(() => {
    const filtered = entries
      .filter((e) => e.status === tab)
      .filter((e) => matchPurpose(e.purpose, purpose))
      .filter((e) => matchIelts(e.ielts, ielts))
      .filter((e) => matchGroup(e, group))
      .filter((e) => (starredOnly ? e.starred === true : true));
    return [...filtered].sort(buildComparator(sortKey));
  }, [entries, tab, purpose, ielts, group, starredOnly, sortKey]);

  // 雅思导入组名取自用户已有数据（去重 + 按字典序）。当列表里一个组都没时，
  // 下拉隐藏，避免无雅思导入的用户看到空控件。
  // 另外：手动查询后勾选"雅思"但未指定组的词会被归到 "__none__"（其他），
  // 让用户能筛选"雅思里所有散词"。
  const groupOptions = useMemo(() => {
    const names = new Set<string>();
    let hasOrphan = false;
    for (const e of entries) {
      if (!e.ielts) continue;
      const g = (e.group ?? "").trim();
      if (g) names.add(g);
      else hasOrphan = true;
    }
    const sorted = Array.from(names).sort((a, b) =>
      a.localeCompare(b, "zh-Hans-CN"),
    );
    // "其他"固定排在真经组之后，方便快速定位散词。
    if (hasOrphan) sorted.push("__none__");
    return sorted;
  }, [entries]);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = useMemo(
    () => visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [visible, safePage],
  );

  /**
   * Write one or more search params to the URL. Uses replace so filter
   * flipping doesn't fill history with intermediate states — only the final
   * "click a word → detail" navigation should push.
   *
   * `resetPage=true` clears ?page so switching tabs / filters returns to
   * the first page (otherwise page=3 on old-friend list persists into the
   * new-friend list which may only have 5 words total).
   */
  const setParams = useCallback(
    (
      patch: Record<string, string | null>,
      opts?: { resetPage?: boolean; push?: boolean },
    ) => {
      if (typeof window === "undefined") return;
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") params.delete(k);
        else params.set(k, v);
      }
      if (opts?.resetPage) params.delete("page");
      const qs = params.toString();
      const url = qs ? `/wordbook?${qs}` : "/wordbook";
      // Filter toggles use replace so we don't pollute browser history with
      // every micro-interaction. Pagination uses push so "click word → detail
      // → back" returns to the exact page the user was on (otherwise the
      // browser skips past all replace()'d page transitions and lands on
      // page 1).
      if (opts?.push) router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [router, searchParams],
  );

  // Snap the URL's page back into range if visible shrinks (e.g. word moved
  // to another tab and the current page is now empty).
  useEffect(() => {
    if (page > totalPages) {
      setParams({ page: totalPages === 1 ? null : String(totalPages) });
    }
  }, [page, totalPages, setParams]);

  function setTab(next: WordbookStatus) {
    setParams({ tab: next === "new" ? null : next }, { resetPage: true });
  }
  function setPurpose(next: PurposeFilter) {
    setParams({ purpose: next === "all" ? null : next }, { resetPage: true });
  }
  function setIeltsFilter(next: IeltsFilter) {
    // 切换雅思筛选时组名筛选失效（非雅思本就无组归属），直接清掉 group 参数，
    // 避免用户看到“筛了组但一条没”的困惑现象。
    setParams(
      { ielts: next === "all" ? null : next, group: null },
      { resetPage: true },
    );
  }
  function setGroupFilter(next: GroupFilter) {
    // 选了具体组名隐含“只看雅思”；切回 all 保留当前 ielts 的选择。
    if (next === "all") {
      setParams({ group: null }, { resetPage: true });
    } else {
      setParams(
        { group: next, ielts: ielts === "nonielts" ? "ielts" : ielts === "all" ? "ielts" : ielts },
        { resetPage: true },
      );
    }
  }
  function setSortKey(next: SortKey) {
    setParams({ sort: next === "recent" ? null : next }, { resetPage: true });
  }
  function setStarredFilter(next: boolean) {
    setParams({ starred: next ? "1" : null }, { resetPage: true });
  }
  function setPage(next: number) {
    setParams({ page: next <= 1 ? null : String(next) }, { push: true });
  }

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
          {/* 雅思词组下拉——仅当用户有过雅思导入组时才展示，避免非雅思用户看到空控件。
              选中具体组名隐含“只看雅思”（setGroupFilter 里已处理）。 */}
          {groupOptions.length > 0 && (
            <label className="inline-flex items-center gap-1.5 text-[var(--fg-soft)]">
              雅思词组
              <select
                value={group}
                onChange={(e) => setGroupFilter(e.target.value)}
                className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-[var(--fg)] outline-none"
              >
                <option value="all">全部组</option>
                {groupOptions.map((g) => (
                  <option key={g} value={g}>
                    {g === "__none__" ? "其他（无组）" : g}
                  </option>
                ))}
              </select>
            </label>
          )}
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
          {/* 标星筛选开关——点击切换"只看已标星"。用实心星图标作视觉。
              激活态用主色边框 + 浅蓝底突出，未激活时半透明淡化，方便一眼看出状态。 */}
          <button
            type="button"
            onClick={() => setStarredFilter(!starredOnly)}
            title={starredOnly ? "取消筛选：显示全部" : "只看已标星的单词"}
            aria-pressed={starredOnly}
            className={[
              "inline-flex h-8 w-8 items-center justify-center rounded-md border transition",
              starredOnly
                ? "border-[var(--accent)] bg-[var(--accent)]/10"
                : "border-[var(--border)] opacity-60 hover:opacity-100 hover:border-[var(--fg-soft)]",
            ].join(" ")}
          >
            <Image
              src="/icons/star-filled.png"
              alt=""
              width={24}
              height={24}
              className="h-5 w-5 object-contain"
            />
          </button>
        </div>
      </header>

      {/* 自动连播工具栏——馈入当前可见页 paginated 的 lemma 列表。
          翻页 / 换筛选造成列表变化时，AutoPlayer 会自动停止。 */}
      {visible.length > 0 && (
        <WordAutoPlayer
          words={paginated.map((e) => e.lemma)}
          onCurrentChange={setPlayingLemma}
        />
      )}

      {/* List */}
      {visible.length === 0 ? (
        <p className="text-sm text-[var(--fg-soft)]">
          {tab === "new"
            ? "还没有新朋友。先去查几个生词吧。"
            : "还没有老朋友。完成复习的单词会自动来到这里。"}
        </p>
      ) : (
        <ul className="rounded-lg border border-[var(--border)]">
          {paginated.map((e) => {
            const isNew = e.status === "new";
            const moveTitle =
              isNew ? "已掌握，移到老朋友" : "还想再看，移回新朋友";
            const isRevealed = revealedLemma === e.lemma;
            const showLemma = !masked || isRevealed;
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
            // 卡片里只显示英文——中文放在详情页看。stripChinese 会把 "en — cn" 中的
            // "— cn" 去掉；纯英文串保持不变。
            const previewExample = stripChinese(e.coreExample ?? "");
            const isPlaying = playingLemma === e.lemma;
            return (
              <li key={e.lemma} className="group">
                <div
                  className={[
                    "flex items-center gap-3 px-4 py-3 transition hover:bg-[var(--bg-soft)]",
                    isPlaying ? "bg-[var(--accent)]/10" : "",
                  ].join(" ")}
                >
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
                        {previewExample && showLemma && (
                          <div
                            className="mt-1 line-clamp-2 text-sm leading-snug text-[var(--fg-soft)]"
                            title={previewExample}
                          >
                            {previewExample}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    // 详情页在新标签页打开：这样点单词绝不会破坏当前列表
                    // 的 tab / 筛选 / 页码 / 滚动位置。之前尝试用 ?page=N +
                    // 浏览器 back 恢复页码，遇到 bfcache / RSC 缓存 / effect
                    // 时序等场景仍会偶发跳回第一页，索性用新窗口彻底绕开。
                    // 用普通 <a> 而非 next/link — 我们本来就不想要软导航。
                    <a
                      href={`/word/${encodeURIComponent(e.lemma)}?from=wordbook`}
                      target="_blank"
                      rel="noopener noreferrer"
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
                        {previewExample && (
                          <div
                            className="mt-1 line-clamp-2 text-sm leading-snug text-[var(--fg-soft)]"
                            title={previewExample}
                          >
                            {previewExample}
                          </div>
                        )}
                      </div>
                    </a>
                  )}
                  <button
                    type="button"
                    title={e.starred ? "取消标星" : "标星（重点复习）"}
                    aria-label={e.starred ? `取消 ${e.lemma} 的标星` : `标星 ${e.lemma}`}
                    aria-pressed={e.starred === true}
                    onClick={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      toggleStar(e.lemma);
                    }}
                    className="shrink-0 rounded-md p-1 leading-none transition hover:scale-110 active:scale-95"
                  >
                    <Image
                      src={e.starred ? "/icons/star-filled.png" : "/icons/star-outline.png"}
                      alt=""
                      width={40}
                      height={40}
                      className="h-8 w-8 object-contain"
                    />
                  </button>
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

      {visible.length > 0 && totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-1">
          <button
            type="button"
            disabled={safePage === 1}
            onClick={() => setPage(Math.max(1, safePage - 1))}
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
            onClick={() => setPage(Math.min(totalPages, safePage + 1))}
            aria-label="下一页"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border)] bg-transparent text-sm text-[var(--fg-soft)] transition hover:text-[var(--fg)] hover:border-[var(--fg-soft)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ›
          </button>
        </div>
      )}

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

function matchIelts(
  stored: boolean | undefined,
  want: IeltsFilter,
): boolean {
  if (want === "all") return true;
  const isIelts = stored === true;
  return want === "ielts" ? isIelts : !isIelts;
}

/**
 * 雅思词组名匹配。`want = "all"` 不筛；`want = "__none__"` 表示"雅思里未归组
 * 的散词"（用户手动查询后勾了"雅思"但没填组）；其他值按组名精确匹配。
 * 非雅思词天然没 group，会被直接过滤掉——这与“选了具体组名隐含只看雅思”
 * 的 UI 预期一致。
 */
function matchGroup(entry: WordbookEntry, want: GroupFilter): boolean {
  if (want === "all") return true;
  const g = (entry.group ?? "").trim();
  if (want === "__none__") return !g;
  return g === want;
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
    case "error":
      return (a: WordbookEntry, b: WordbookEntry) => {
        const ae = a.errorCount ?? 0;
        const be = b.errorCount ?? 0;
        if (ae !== be) return be - ae;
        return a.lemma < b.lemma ? -1 : 1;
      };
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

function maskLemma(lemma: string): string {
  return lemma
    .split("")
    .map((ch) => (/[a-zA-Z]/.test(ch) ? "•" : ch))
    .join("");
}

/**
 * Strip the "— 中文" suffix from a coreExample. Cards should show English
 * only; the full "en — cn" form is reserved for the detail page. Handles
 * both em-dash "—" and en-dash "–" plus surrounding whitespace, and only
 * trims when what follows contains any CJK character (so English-only
 * dashes in the sentence itself aren't cut).
 */
function stripChinese(s: string): string {
  const idx = s.search(/\s*[—–]\s*/);
  if (idx < 0) return s;
  const tail = s.slice(idx);
  if (/[\u4e00-\u9fff]/.test(tail)) return s.slice(0, idx).trim();
  return s;
}
