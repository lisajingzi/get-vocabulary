"use client";

/**
 * /notebook — the phrase / sentence notebook.
 *
 * Sits alongside 单词本 in the top nav, but is a completely separate
 * data domain: no 新朋友/老朋友 status, no review queue, no daily card.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────┐
 *   │ 笔记本                             共 xx 条           │
 *   │ [ 短语 · N ]  [ 句子 · M ]           ✏️ 记短语        │
 *   │ ────────────────────────────────────────────────── │
 *   │ • take advantage of                    06月30日     │
 *   │ • by the way                           06月28日     │
 *   └──────────────────────────────────────────────────┘
 *
 * Rows link to:
 *   - phrase   → /notebook/phrase/<slug>
 *   - sentence → /notebook/sentence/<id>
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  addDistinction,
  listEntries,
  type NotebookEntry,
  type NotebookKind,
} from "@/lib/notebook/local";

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  if (d.getFullYear() === now.getFullYear()) {
    return `${mm}月${dd}日`;
  }
  return `${d.getFullYear()}年${mm}月${dd}日`;
}

export default function NotebookPage() {
  const router = useRouter();
  const [entries, setEntries] = useState<NotebookEntry[]>([]);
  const [tab, setTab] = useState<NotebookKind>("phrase");

  useEffect(() => {
    function refresh() {
      setEntries(listEntries());
    }
    refresh();
    window.addEventListener("get:notebook-change", refresh);
    window.addEventListener("get:notebook-notes-change", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("get:notebook-change", refresh);
      window.removeEventListener("get:notebook-notes-change", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const counts = useMemo(() => {
    let phrase = 0;
    let sentence = 0;
    let distinction = 0;
    for (const e of entries) {
      if (e.kind === "phrase") phrase += 1;
      else if (e.kind === "sentence") sentence += 1;
      else if (e.kind === "distinction") distinction += 1;
    }
    return { phrase, sentence, distinction };
  }, [entries]);

  const visible = useMemo(
    () => entries.filter((e) => e.kind === tab),
    [entries, tab],
  );

  const addLabel =
    tab === "phrase" ? "记短语" : tab === "sentence" ? "记句子" : "记辨析";
  // Phrase / sentence entries are typed on the /notebook/new form first,
  // then a row is created on submit. Distinction entries are big enough
  // (word list + freeform) that a lightweight form would just be a
  // redirect anyway — so we skip it: 记辨析 spawns an empty row and
  // jumps straight to its detail editor.
  const addHref =
    tab === "distinction" ? undefined : `/notebook/new?kind=${tab}`;

  function handleCreateDistinction() {
    const entry = addDistinction();
    router.push(`/notebook/distinction/${encodeURIComponent(entry.id)}`);
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
            <h1 className="text-xl font-semibold tracking-tight">笔记本</h1>
          </div>
          <span className="text-xs text-[var(--fg-soft)]">
            共{" "}
            <span className="font-medium text-[var(--fg)]">
              {visible.length}
            </span>{" "}
            条
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Tabs */}
          <div className="inline-flex rounded-md border border-[var(--border)] p-0.5">
            {(
              [
                { key: "phrase", label: `短语 · ${counts.phrase}` },
                { key: "sentence", label: `句子 · ${counts.sentence}` },
                { key: "distinction", label: `辨析 · ${counts.distinction}` },
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

          {/* Add-entry entry point — label follows the current tab.
              Distinction uses a plain <button> that creates an empty row
              inline and jumps to its editor; the other kinds still go
              through the /notebook/new composer. */}
          {addHref ? (
            <Link
              href={addHref}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-3 py-1 text-sm text-[var(--fg-soft)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              ✏️ {addLabel}
            </Link>
          ) : (
            <button
              type="button"
              onClick={handleCreateDistinction}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-3 py-1 text-sm text-[var(--fg-soft)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              ✏️ {addLabel}
            </button>
          )}
        </div>
      </header>

      {visible.length === 0 ? (
        <p className="text-sm text-[var(--fg-soft)]">
          {tab === "phrase"
            ? "还没有记录任何短语。可以在上方搜索短语，或点击「记短语」自己写一条。"
            : tab === "sentence"
            ? "还没有记录任何句子。点击「记句子」写一条你想记住的话吧。"
            : "还没有记录任何词义辨析。点击「记辨析」把容易混淆的一组词整理到一起。"}
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
          {visible.map((e) => {
            const href =
              e.kind === "phrase"
                ? `/notebook/phrase/${encodeURIComponent(e.id)}`
                : e.kind === "sentence"
                ? `/notebook/sentence/${encodeURIComponent(e.id)}`
                : `/notebook/distinction/${encodeURIComponent(e.id)}`;
            // Distinction rows show the derived title; when the user
            // has just created a row but not typed anything yet, `text`
            // is an empty string — show a placeholder so the row is
            // still discoverable and clickable.
            const displayText =
              e.kind === "distinction" && !e.text ? "未命名辨析" : e.text;
            return (
              <li key={e.id} className="group">
                <Link
                  href={href}
                  className="flex items-center gap-3 px-4 py-3 transition hover:bg-[var(--bg-soft)]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span
                        className={[
                          "min-w-0 flex-1 truncate",
                          e.kind === "phrase" || e.kind === "distinction"
                            ? "font-medium"
                            : "text-sm text-[var(--fg)]",
                          e.kind === "distinction" && !e.text
                            ? "text-[var(--fg-soft)]"
                            : "",
                        ].join(" ")}
                        title={displayText}
                      >
                        {displayText}
                      </span>
                      {e.source === "ai" && (
                        <span className="shrink-0 rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--accent)]">
                          AI
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-xs text-[var(--fg-soft)]">
                    {formatDate(e.updatedAt)}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Navigate to the previous page. Falls back to the home surface when there
 * is no in-app history (e.g. the user landed on /notebook via a bookmark or
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
