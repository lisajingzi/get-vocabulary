"use client";

/**
 * /notebook/distinction/[id] — 词义辨析 detail page.
 *
 * A distinction entry is a small group of related words (e.g.
 * `affect / effect / impact`) the user records to keep the differences
 * straight. The page has two modes:
 *
 *   • view — the default. Read-only render of the words / explanations /
 *     freeform notes. Header shows a 修改 button that flips to edit mode.
 *   • edit — the original inline editor: word rows can be added / removed,
 *     explanations toggled, 通用笔记 typed. Auto-save still runs in the
 *     background (300 ms debounce + immediate flush on structural changes
 *     / blur / unmount) so nothing is lost even if the user forgets to
 *     click 保存 — but the button is what the user reaches for and also
 *     flips back to view mode.
 *
 * Mode is reflected in the URL as `?edit=1` so:
 *   - Freshly-created (empty) entries can be linked directly into edit
 *     mode (see /notebook/new).
 *   - Refreshing the page keeps whichever mode the user was in.
 *
 * Layout (top → bottom):
 *   1. Back link + derived title (words joined by " / ") + 修改/保存 button
 *   2. Word list — either read-only chips (view) or editable rows (edit).
 *   3. 通用大框 — read-only text (view) or textarea (edit).
 *   4. 删除本条辨析 (edit mode only, to avoid accidental deletion).
 *
 * The derived title updates live as the user types; the list page and
 * word-detail cross-refs pick it up via the `get:notebook-change` event
 * fired by writeEntries().
 */

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/Toast";
import {
  deleteEntry,
  type DistinctionWord,
  distinctionTitle,
  getEntry,
  type NotebookEntry,
  updateDistinction,
} from "@/lib/notebook/local";

// Debounce for text-input auto-save. Structural changes (add/remove row)
// flush immediately so undoing a delete never means losing an edit.
const AUTOSAVE_MS = 300;

function makeLocalId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `dw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Turn a free-form word string into the /word/<slug> URL segment.
 * We reuse the same lower-case + trim contract the dictionary lookup uses
 * (see WordDetailView.tsx). Multi-word entries ("in spite of") still URL-
 * encode fine; the dictionary will show "not found" for those, which is
 * expected — the link is a convenience, not a promise of a hit.
 */
function wordHref(word: string): string {
  return `/word/${encodeURIComponent(word.trim().toLowerCase())}`;
}

/**
 * Is this entry effectively empty? Used to auto-enter edit mode when the
 * user lands on a freshly-created entry with nothing to look at.
 */
function isEmptyDistinction(e: NotebookEntry): boolean {
  const noWords = !e.words || e.words.every((w) => !w.word.trim());
  const noFree = !(e.freeform && e.freeform.trim());
  return noWords && noFree;
}

function DistinctionDetailInner() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const id = decodeURIComponent(params?.id ?? "");

  const [entry, setEntry] = useState<NotebookEntry | null>(null);
  const [loading, setLoading] = useState(true);

  // "view" (read-only) vs "edit" (original inline editor). Initial mode is
  // decided after the entry loads: empty entries default to edit so a
  // fresh 记辨析 flow doesn't dead-end on a blank page.
  const [mode, setMode] = useState<"view" | "edit">(() =>
    search?.get("edit") === "1" ? "edit" : "view",
  );
  // Once we've synced mode from the loaded entry, don't do it again — the
  // user's manual toggles take precedence for the rest of the session.
  const initedModeRef = useRef(false);

  // Local editing draft. We keep the source of truth in localStorage but
  // buffer keystrokes here to avoid re-rendering the whole tree on every
  // character. Flushed to storage via the debounce timer below.
  const [words, setWords] = useState<DistinctionWord[]>([]);
  const [freeform, setFreeform] = useState<string>("");

  // Debounce handle — cleared on every keystroke, fires 300 ms after the
  // last one, or is force-fired via flushNow() on unmount / blur / delete.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest pending payload; kept in a ref so flushNow() always writes the
  // freshest values even if React state hasn't reconciled yet.
  const pendingRef = useRef<{
    words: DistinctionWord[];
    freeform: string;
  } | null>(null);

  const refresh = useCallback(() => {
    const e = getEntry(id);
    if (e && e.kind === "distinction") {
      setEntry(e);
      // Only replace local draft on first load; ignoring subsequent
      // storage events keeps the user's in-flight edits from being
      // clobbered by our own writes echoing back through the event bus.
      setWords((prev) => (prev.length === 0 && !pendingRef.current ? e.words ?? [] : prev));
      setFreeform((prev) => (prev === "" && !pendingRef.current ? e.freeform ?? "" : prev));
      // First load: if the URL didn't force a mode and the entry is
      // essentially empty, drop the user right into edit mode.
      if (!initedModeRef.current) {
        initedModeRef.current = true;
        if (search?.get("edit") !== "1" && isEmptyDistinction(e)) {
          setMode("edit");
        }
      }
    } else {
      setEntry(null);
    }
    setLoading(false);
  }, [id, search]);

  useEffect(() => {
    refresh();
    // Note: we deliberately do NOT re-hydrate `words` / `freeform` on
    // every storage event — that would fight the user's typing. External
    // changes (e.g. sync pull) only take effect on next page mount.
  }, [refresh]);

  // Ensure any pending debounce is flushed when the user navigates away
  // (route change, tab close). We rely on the effect cleanup rather than
  // beforeunload since the localStorage write is synchronous & cheap.
  useEffect(() => {
    return () => {
      flushNow();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function flushNow() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const payload = pendingRef.current;
    pendingRef.current = null;
    if (!payload) return;
    updateDistinction(id, payload);
  }

  function scheduleSave(next: {
    words: DistinctionWord[];
    freeform: string;
  }) {
    pendingRef.current = next;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const payload = pendingRef.current;
      pendingRef.current = null;
      timerRef.current = null;
      if (payload) updateDistinction(id, payload);
    }, AUTOSAVE_MS);
  }

  function updateWord(idx: number, patch: Partial<DistinctionWord>) {
    setWords((prev) => {
      const next = prev.slice();
      next[idx] = { ...next[idx], ...patch };
      scheduleSave({ words: next, freeform });
      return next;
    });
  }

  function addWord() {
    setWords((prev) => {
      const next = [...prev, { id: makeLocalId(), word: "" }];
      // Structural changes flush immediately so the row survives even if
      // the user closes the tab before typing anything else.
      pendingRef.current = { words: next, freeform };
      flushNow();
      return next;
    });
  }

  function removeWord(idx: number) {
    setWords((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      pendingRef.current = { words: next, freeform };
      flushNow();
      return next;
    });
  }

  function toggleExplanation(idx: number) {
    setWords((prev) => {
      const cur = prev[idx];
      const next = prev.slice();
      // Undefined ↔ "" toggle. Non-empty explanations get cleared to
      // undefined (which the row then re-collapses on).
      if (cur.explanation === undefined) {
        next[idx] = { ...cur, explanation: "" };
      } else {
        next[idx] = { ...cur, explanation: undefined };
      }
      pendingRef.current = { words: next, freeform };
      flushNow();
      return next;
    });
  }

  function updateFreeform(v: string) {
    setFreeform(v);
    scheduleSave({ words, freeform: v });
  }

  function handleDelete() {
    if (!entry) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm("确定删除这条辨析？无法恢复。")
    ) {
      return;
    }
    // Cancel any pending autosave so it can't resurrect the row post-nav.
    if (timerRef.current) clearTimeout(timerRef.current);
    pendingRef.current = null;
    deleteEntry(entry.id);
    toast("已删除辨析");
    router.push("/notebook");
  }

  /**
   * URL sync helper. Keeps `?edit=1` in the address bar in sync with
   * `mode`, using replace() so mode flips don't clutter the history.
   */
  function writeModeToUrl(next: "view" | "edit") {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (next === "edit") url.searchParams.set("edit", "1");
    else url.searchParams.delete("edit");
    router.replace(url.pathname + (url.search ? url.search : ""));
  }

  function enterEditMode() {
    setMode("edit");
    writeModeToUrl("edit");
  }

  function saveAndExitEditMode() {
    // Force any pending debounced write out synchronously so 保存 has the
    // guarantee the user expects: after clicking it, storage is up-to-date.
    flushNow();
    setMode("view");
    writeModeToUrl("view");
    toast("已保存");
  }

  const title = useMemo(() => distinctionTitle(words), [words]);

  if (loading) {
    return <p className="text-sm text-[var(--fg-soft)]">加载中…</p>;
  }

  if (!entry) {
    return (
      <div className="mx-auto max-w-2xl space-y-3">
        <Link
          href="/notebook"
          className="text-xs text-[var(--fg-soft)] hover:text-[var(--accent)]"
        >
          ← 返回笔记本
        </Link>
        <p className="text-sm text-[var(--fg-soft)]">未找到这条辨析。</p>
      </div>
    );
  }

  const isEditing = mode === "edit";
  // In view mode we filter out fully-empty word rows so stray blanks from
  // an earlier edit session don't render as gray placeholders.
  const visibleWords = isEditing
    ? words
    : words.filter((w) => w.word.trim() || (w.explanation ?? "").trim());

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header className="space-y-2">
        <div className="flex items-center justify-between gap-2 text-xs text-[var(--fg-soft)]">
          <Link href="/notebook" className="hover:text-[var(--accent)]">
            ← 返回笔记本
          </Link>
          <div className="flex items-center gap-3">
            {isEditing ? (
              <button
                type="button"
                onClick={saveAndExitEditMode}
                className="rounded-md border border-[var(--accent)] px-2.5 py-1 text-xs text-[var(--accent)] transition hover:bg-[var(--accent)] hover:text-white"
              >
                保存
              </button>
            ) : (
              <button
                type="button"
                onClick={enterEditMode}
                className="rounded-md border border-[var(--border)] px-2.5 py-1 text-xs transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                修改
              </button>
            )}
            {isEditing && (
              <button
                type="button"
                onClick={handleDelete}
                className="hover:text-red-500"
              >
                删除
              </button>
            )}
          </div>
        </div>
        <h1
          className="text-2xl font-semibold tracking-tight"
          title={title || "未命名辨析"}
        >
          {title || (
            <span className="text-[var(--fg-soft)]">未命名辨析</span>
          )}
        </h1>
        {isEditing && (
          <p className="text-xs text-[var(--fg-soft)]">
            改动会自动保存，点击“保存”结束编辑；随后可点“修改”再次调整。
          </p>
        )}
      </header>

      {/* Word list — read-only chips in view mode, editable rows in edit mode. */}
      <section className="space-y-2">
        <div className="text-xs font-medium uppercase tracking-wide text-[var(--accent)]">
          词条
        </div>

        {!isEditing ? (
          visibleWords.length === 0 ? (
            <p className="text-sm text-[var(--fg-soft)]">
              还没有词条，点右上角“修改”开始添加。
            </p>
          ) : (
            <ul className="space-y-3">
              {visibleWords.map((w) => (
                <li
                  key={w.id}
                  className="rounded-lg border border-[var(--border)] p-3"
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-base font-medium">
                      {w.word.trim() || (
                        <span className="text-[var(--fg-soft)]">（空）</span>
                      )}
                    </span>
                    {w.word.trim() && (
                      <Link
                        href={wordHref(w.word)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="查看单词详情"
                        aria-label="查看单词详情"
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--fg-soft)] transition hover:text-[var(--accent)]"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                          className="h-4 w-4"
                        >
                          <path d="M10 14a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                          <path d="M14 10a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                        </svg>
                      </Link>
                    )}
                  </div>
                  {w.explanation !== undefined && w.explanation.trim() && (
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-[var(--fg-soft)]">
                      {w.explanation}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : (
          <>
            <ul className="space-y-3">
              {words.map((w, idx) => (
                <li
                  key={w.id}
                  className="rounded-lg border border-[var(--border)] p-3"
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={w.word}
                      onChange={(e) => updateWord(idx, { word: e.target.value })}
                      onBlur={flushNow}
                      placeholder="单词或短语，例如 affect"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      className="min-w-0 flex-1 bg-transparent text-base leading-8 caret-[var(--accent)] outline-none"
                    />
                    {/* Link to the word detail page. Only meaningful when a
                        word has actually been typed — otherwise it'd point
                        at /word/ which 404s. */}
                    {w.word.trim() && (
                      <Link
                        href={wordHref(w.word)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="查看单词详情"
                        aria-label="查看单词详情"
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--fg-soft)] transition hover:text-[var(--accent)]"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                          className="h-4 w-4"
                        >
                          <path d="M10 14a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                          <path d="M14 10a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                        </svg>
                      </Link>
                    )}
                    <button
                      type="button"
                      onClick={() => toggleExplanation(idx)}
                      title={
                        w.explanation === undefined ? "添加解释" : "移除解释"
                      }
                      className="shrink-0 text-xs text-[var(--fg-soft)] transition hover:text-[var(--accent)]"
                    >
                      {w.explanation === undefined ? "+ 解释" : "− 解释"}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeWord(idx)}
                      title="删除这个词"
                      aria-label="删除这个词"
                      className="shrink-0 text-xs text-[var(--fg-soft)] transition hover:text-red-500"
                    >
                      ✕
                    </button>
                  </div>
                  {w.explanation !== undefined && (
                    <textarea
                      value={w.explanation}
                      onChange={(e) =>
                        updateWord(idx, { explanation: e.target.value })
                      }
                      onBlur={flushNow}
                      rows={2}
                      placeholder="这个词的解释、用法差异或例句"
                      className="mt-2 w-full resize-none bg-transparent text-sm leading-7 text-[var(--fg-soft)] caret-[var(--accent)] outline-none"
                    />
                  )}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={addWord}
              className="rounded-md border border-dashed border-[var(--border)] px-3 py-1.5 text-sm text-[var(--fg-soft)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              ➕ 加一个词
            </button>
          </>
        )}
      </section>

      {/* Free-form 通用大框 — read-only paragraph (view) or textarea (edit). */}
      <section className="space-y-2">
        <div className="text-xs font-medium uppercase tracking-wide text-[var(--fg-soft)]">
          通用笔记{isEditing ? "（可选）" : ""}
        </div>
        {isEditing ? (
          <textarea
            value={freeform}
            onChange={(e) => updateFreeform(e.target.value)}
            onBlur={flushNow}
            rows={6}
            placeholder="把这一组词放在一起对比的心得、共通例句、语域差异……"
            className="w-full resize-y rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-base leading-8 caret-[var(--accent)] outline-none focus:border-[var(--accent)]"
          />
        ) : freeform.trim() ? (
          <p className="whitespace-pre-wrap rounded-lg border border-[var(--border)] px-3 py-2 text-base leading-8">
            {freeform}
          </p>
        ) : (
          <p className="text-sm text-[var(--fg-soft)]">（暂无通用笔记）</p>
        )}
      </section>

      {isEditing && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={saveAndExitEditMode}
            className="rounded-md border border-[var(--accent)] px-3 py-1.5 text-sm text-[var(--accent)] transition hover:bg-[var(--accent)] hover:text-white"
          >
            保存
          </button>
        </div>
      )}
    </div>
  );
}

export default function DistinctionDetailPage() {
  // useSearchParams() puts this route into Next.js's Suspense contract at
  // build time. The wrapper keeps SSR happy without requiring dynamic=force.
  return (
    <Suspense fallback={<p className="text-sm text-[var(--fg-soft)]">加载中…</p>}>
      <DistinctionDetailInner />
    </Suspense>
  );
}
