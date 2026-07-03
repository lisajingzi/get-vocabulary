"use client";

/**
 * /notebook/new — manual entry composer for the notebook.
 *
 * Query params:
 *   kind = "phrase" | "sentence"   (defaults to "phrase")
 *
 * The form has two fields:
 *   1. The phrase / sentence text itself (required).
 *   2. An optional first note. If the user typed something here, we save
 *      it as the entry's first NotebookNote so they don't have to click
 *      through to the detail page just to jot down what triggered them
 *      to record this.
 *
 * On submit:
 *   - phrase   → upsertPhrase({ source: "manual" }); redirect to
 *                /notebook/phrase/<slug>
 *   - sentence → addSentence(); redirect to /notebook/sentence/<id>
 *
 * useSearchParams() forces this route into Suspense during the Next.js build,
 * so we split the reader into an inner component and wrap it below.
 */

import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense, useMemo, useState } from "react";
import {
  addNote,
  addSentence,
  type NotebookKind,
  upsertPhrase,
} from "@/lib/notebook/local";

function NewNotebookEntryForm() {
  const router = useRouter();
  const search = useSearchParams();
  const rawKind = (search.get("kind") ?? "phrase") as NotebookKind;
  const kind: NotebookKind = rawKind === "sentence" ? "sentence" : "phrase";

  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const heading = kind === "phrase" ? "记短语" : "记句子";
  const placeholder =
    kind === "phrase"
      ? "输入你想记录的英文短语，例如：take advantage of"
      : "输入你想记录的英文句子";
  const notePlaceholder =
    kind === "phrase"
      ? "关于这个短语的第一条笔记（可选）"
      : "关于这个句子的第一条笔记（可选）";
  // Basic client-side validation. Empty strings and pure-punctuation get rejected.
  const canSave = useMemo(
    () => text.trim().length > 0 && /[a-zA-Z\u4e00-\u9fff0-9]/.test(text),
    [text],
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const trimmed = text.trim();
      let dest: string;
      if (kind === "phrase") {
        const entry = upsertPhrase({ text: trimmed, source: "manual" });
        if (note.trim()) {
          addNote(entry.id, note.trim());
        }
        dest = `/notebook/phrase/${encodeURIComponent(entry.id)}`;
      } else {
        const entry = addSentence(trimmed);
        if (note.trim()) {
          addNote(entry.id, note.trim());
        }
        dest = `/notebook/sentence/${encodeURIComponent(entry.id)}`;
      }
      router.push(dest);
    } catch (e2) {
      setErr((e2 as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <header className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-[var(--fg-soft)]">
          <Link href="/notebook" className="hover:text-[var(--accent)]">
            ← 返回笔记本
          </Link>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{heading}</h1>
      </header>

      <form
        onSubmit={handleSubmit}
        className="space-y-4 rounded-lg border border-[var(--border)] p-4"
      >
        <div className="space-y-1">
          <label
            htmlFor="notebook-text"
            className="text-xs font-medium uppercase tracking-wide text-[var(--accent)]"
          >
            {kind === "phrase" ? "短语" : "句子"}
          </label>
          {kind === "phrase" ? (
            <input
              id="notebook-text"
              type="text"
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder={placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
className="w-full rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-base leading-9 caret-[var(--accent)] outline-none focus:border-[var(--accent)]"
            />
          ) : (
            <textarea
              id="notebook-text"
              autoFocus
              rows={4}
              placeholder={placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
className="w-full resize-none rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-base leading-9 caret-[var(--accent)] outline-none focus:border-[var(--accent)]"
            />
          )}
        </div>

        <div className="space-y-1">
          <label
            htmlFor="notebook-note"
            className="text-xs font-medium uppercase tracking-wide text-[var(--fg-soft)]"
          >
            首条笔记（可选）
          </label>
          <textarea
            id="notebook-note"
            rows={3}
            placeholder={notePlaceholder}
            value={note}
            onChange={(e) => setNote(e.target.value)}
className="w-full resize-none rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-base leading-9 caret-[var(--accent)] outline-none focus:border-[var(--accent)]"
          />
        </div>

        {err && <p className="text-xs text-red-500">保存失败：{err}</p>}

        <div className="flex items-center justify-end gap-2">
          <Link
            href="/notebook"
            className="rounded-md border border-[var(--border)] px-3 py-1 text-xs text-[var(--fg-soft)] transition hover:text-[var(--fg)]"
          >
            取消
          </Link>
          <button
            type="submit"
            disabled={!canSave || busy}
            className="rounded-md border border-[var(--border)] px-3 py-1 text-xs transition hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function NewNotebookEntryPage() {
  return (
    <Suspense
      fallback={
        <p className="text-sm text-[var(--fg-soft)]">加载中…</p>
      }
    >
      <NewNotebookEntryForm />
    </Suspense>
  );
}
