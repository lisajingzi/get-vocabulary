"use client";

/**
 * /notebook/sentence/[id] — sentence detail page.
 *
 * Sentences are always manual (see spec — Q4 locked "sentences are manual
 * only, no AI"). This page is therefore much simpler than the phrase page:
 *   - Show the sentence text with a speak button.
 *   - Allow the user to edit the sentence text inline.
 *   - Allow deletion (小的"删除"按钮).
 *   - Mount NotebookNotesPanel for the free-form notes.
 */

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import NotebookNotesPanel from "@/components/NotebookNotesPanel";
import SpeakButton from "@/components/SpeakButton";
import { toast } from "@/components/Toast";
import {
  deleteEntry,
  getEntry,
  type NotebookEntry,
  updateEntryText,
} from "@/lib/notebook/local";

export default function SentenceDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = decodeURIComponent(params?.id ?? "");

  const [entry, setEntry] = useState<NotebookEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const refresh = useCallback(() => {
    const e = getEntry(id);
    setEntry(e && e.kind === "sentence" ? e : null);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    refresh();
    function onChange() {
      refresh();
    }
    window.addEventListener("get:notebook-change", onChange);
    return () => window.removeEventListener("get:notebook-change", onChange);
  }, [refresh]);

  function startEdit() {
    if (!entry) return;
    setDraft(entry.text);
    setEditing(true);
  }

  function commitEdit() {
    if (!entry) return;
    const body = draft.trim();
    if (!body) return;
    updateEntryText(entry.id, body);
    setEditing(false);
  }

  function cancelEdit() {
    setEditing(false);
    setDraft("");
  }

  function handleDelete() {
    if (!entry) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm("确定删除这条句子？相关笔记也会一并删除。")
    ) {
      return;
    }
    deleteEntry(entry.id);
    toast("已从笔记本删除");
    router.push("/notebook");
  }

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
        <p className="text-sm text-[var(--fg-soft)]">未找到这条句子。</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header className="space-y-3">
        <div className="flex items-center gap-2 text-xs text-[var(--fg-soft)]">
          <Link href="/notebook" className="hover:text-[var(--accent)]">
            ← 返回笔记本
          </Link>
        </div>

        <div className="rounded-lg border border-[var(--border)] p-4">
          {editing ? (
            <div className="space-y-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={4}
className="w-full resize-none bg-transparent text-base leading-9 caret-[var(--accent)] outline-none"
                autoFocus
              />
              <div className="flex justify-end gap-2 text-xs">
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="text-[var(--fg-soft)] hover:text-[var(--fg)]"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={commitEdit}
                  disabled={!draft.trim()}
                  className="rounded-md border border-[var(--border)] px-2.5 py-0.5 transition hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  保存
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-start gap-3">
                <p className="flex-1 text-base leading-relaxed">{entry.text}</p>
                <SpeakButton text={entry.text} variant="us" />
              </div>
              <div className="flex justify-end gap-3 text-xs text-[var(--fg-soft)]">
                <button
                  type="button"
                  onClick={startEdit}
                  className="hover:text-[var(--accent)]"
                >
                  编辑
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  className="hover:text-red-500"
                >
                  删除
                </button>
              </div>
            </div>
          )}
        </div>
      </header>

      <NotebookNotesPanel
        entryId={entry.id}
        placeholder="记录这句话对你的意义、场景或想法…"
      />
    </div>
  );
}
