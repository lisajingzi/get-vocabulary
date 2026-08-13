"use client";

/**
 * <NotebookNotesPanel /> — free-form note list attached to a notebook entry.
 *
 * Simpler than the wordbook <NotesPanel />:
 *   - No pos picker (notebook entries don't carry a part of speech).
 *   - Text-only for now (image support can be revived later; the storage
 *     layer already keeps the field so nothing needs to migrate).
 *   - Newest first, edit-in-place, delete with confirm.
 *
 * Consumed by both /notebook/phrase/[slug] and /notebook/sentence/[id] so
 * the two detail pages don't drift apart.
 */

import { useCallback, useEffect, useState } from "react";
import {
  addNote,
  deleteNote,
  listNotes,
  type NotebookNote,
  updateNote,
} from "@/lib/notebook/local";

interface Props {
  entryId: string;
  /** Optional heading override; defaults to "笔记". */
  title?: string;
  /** Optional placeholder for the composer's textarea. */
  placeholder?: string;
}

export default function NotebookNotesPanel({
  entryId,
  title = "笔记",
  placeholder = "写下你的笔记…",
}: Props) {
  const [notes, setNotes] = useState<NotebookNote[]>([]);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");

  const refresh = useCallback(() => {
    setNotes(listNotes(entryId));
  }, [entryId]);

  useEffect(() => {
    refresh();
    function onChange() {
      refresh();
    }
    window.addEventListener("get:notebook-notes-change", onChange);
    return () =>
      window.removeEventListener("get:notebook-notes-change", onChange);
  }, [refresh]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    addNote(entryId, body);
    setDraft("");
  }

  function startEdit(note: NotebookNote) {
    setEditingId(note.id);
    setEditBody(note.body);
  }

  function commitEdit(id: string) {
    const body = editBody.trim();
    if (!body) return;
    updateNote(entryId, id, { body });
    setEditingId(null);
    setEditBody("");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditBody("");
  }

  function handleDelete(id: string) {
    if (
      typeof window !== "undefined" &&
      !window.confirm("确定删除这条笔记？")
    ) {
      return;
    }
    deleteNote(entryId, id);
  }

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium uppercase tracking-wide text-[var(--accent)]">
        {title}
      </h2>

      {notes.length === 0 ? (
        <p className="text-xs text-[var(--fg-soft)]">
          还没有笔记，写下你的第一条想法吧。
        </p>
      ) : (
        <ul className="space-y-2">
          {notes.map((note) => {
            const isEditing = editingId === note.id;
            return (
              <li
                key={note.id}
                className="rounded-lg border border-[var(--border)] p-3"
              >
                {isEditing ? (
                  <div className="space-y-2">
                    <textarea
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                      rows={3}
                      className="w-full resize-none bg-transparent text-sm outline-none"
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
                        onClick={() => commitEdit(note.id)}
                        disabled={!editBody.trim()}
                        className="rounded-md border border-[var(--border)] px-2.5 py-0.5 transition hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        保存
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="whitespace-pre-wrap text-sm">{note.body}</p>
                    <div className="flex items-center justify-between text-[11px] text-[var(--fg-soft)]">
                      <span>
                        {new Date(note.updatedAt).toLocaleString("zh-CN", {
                          hour12: false,
                        })}
                      </span>
                      <div className="flex gap-3">
                        <button
                          type="button"
                          onClick={() => startEdit(note)}
                          className="hover:text-[var(--accent)]"
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(note.id)}
                          className="hover:text-red-500"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form
        onSubmit={handleSubmit}
        className="space-y-2 rounded-lg border border-[var(--border)] p-3"
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className="w-full resize-none appearance-none bg-transparent text-base leading-9 caret-[var(--accent)] outline-none ring-0 focus:outline-none focus:ring-0 focus:border-transparent placeholder:text-[var(--fg-soft)]"
        />
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!draft.trim()}
            className="rounded-md border border-[var(--border)] px-3 py-1 text-xs transition hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            保存
          </button>
        </div>
      </form>
    </section>
  );
}
