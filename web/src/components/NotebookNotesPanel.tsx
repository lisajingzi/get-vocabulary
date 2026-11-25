"use client";

/**
 * <NotebookNotesPanel /> — free-form note list attached to a notebook entry.
 *
 * Simpler than the wordbook <NotesPanel />:
 *   - No pos picker (notebook entries don't carry a part of speech).
 *   - Text + optional image attachment (parity with the wordbook notes UX).
 *     Images are downscaled to <=1200px and JPEG-encoded at 0.85 before
 *     being stored as data URLs, keeping localStorage from ballooning.
 *   - Newest first, edit-in-place (body + image), delete with confirm.
 *
 * Consumed by both /notebook/phrase/[slug] and /notebook/sentence/[id] so
 * the two detail pages don't drift apart.
 */

import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  addNote,
  deleteNote,
  listNotes,
  type NotebookNote,
  updateNote,
} from "@/lib/notebook/local";
import { resolveImageSrc, uploadImageFile } from "@/lib/wordbook/image";

interface Props {
  entryId: string;
  /** Optional heading override; defaults to "笔记". */
  title?: string;
  /** Optional placeholder for the composer's textarea. */
  placeholder?: string;
}

// Image attachment pipeline shared with WordDetailView — downscale, upload
// to COS, store only a short reference. See lib/wordbook/image.ts.

export default function NotebookNotesPanel({
  entryId,
  title = "笔记",
  placeholder = "写下你的笔记…",
}: Props) {
  const [notes, setNotes] = useState<NotebookNote[]>([]);
  const [draft, setDraft] = useState("");
  const [draftImage, setDraftImage] = useState<string | undefined>(undefined);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [editImage, setEditImage] = useState<string | undefined>(undefined);
  const composerFileRef = useRef<HTMLInputElement>(null);
  const editFileRef = useRef<HTMLInputElement>(null);

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

  async function handlePickDraftImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const key = await uploadImageFile(file);
      setDraftImage(key);
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert((err as Error).message);
    }
  }

  async function handlePickEditImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const key = await uploadImageFile(file);
      setEditImage(key);
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert((err as Error).message);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body && !draftImage) return;
    addNote(entryId, body, draftImage);
    setDraft("");
    setDraftImage(undefined);
    if (composerFileRef.current) composerFileRef.current.value = "";
  }

  function startEdit(note: NotebookNote) {
    setEditingId(note.id);
    setEditBody(note.body);
    setEditImage(note.image);
  }

  function commitEdit(id: string) {
    const body = editBody.trim();
    // Allow image-only notes: pass image explicitly (null clears, undefined keeps).
    if (!body && !editImage) return;
    updateNote(entryId, id, { body, image: editImage ?? null });
    setEditingId(null);
    setEditBody("");
    setEditImage(undefined);
    if (editFileRef.current) editFileRef.current.value = "";
  }

  function cancelEdit() {
    setEditingId(null);
    setEditBody("");
    setEditImage(undefined);
    if (editFileRef.current) editFileRef.current.value = "";
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

  const canSubmit = draft.trim().length > 0 || Boolean(draftImage);
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
                    {editImage && (
                      <div className="relative inline-block">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={resolveImageSrc(editImage)}
                          alt=""
                          className="max-h-40 rounded border border-[var(--border)]"
                        />
                        <button
                          type="button"
                          onClick={() => setEditImage(undefined)}
                          className="absolute -right-2 -top-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--bg)] text-xs shadow ring-1 ring-[var(--border)]"
                          aria-label="移除图片"
                        >
                          ✕
                        </button>
                      </div>
                    )}
                    <div className="flex items-center justify-between text-xs">
                      <label className="cursor-pointer text-[var(--fg-soft)] hover:text-[var(--accent)]">
                        <input
                          ref={editFileRef}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={handlePickEditImage}
                        />
                        📎 {editImage ? "替换图片" : "添加图片"}
                      </label>
                      <div className="flex gap-2">
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
                          disabled={!editBody.trim() && !editImage}
                          className="rounded-md border border-[var(--border)] px-2.5 py-0.5 transition hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          保存
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {note.body && (
                      <p className="whitespace-pre-wrap text-sm">{note.body}</p>
                    )}
                    {note.image && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={resolveImageSrc(note.image)}
                        alt=""
                        className="max-h-72 rounded border border-[var(--border)]"
                      />
                    )}
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
        {draftImage && (
          <div className="relative inline-block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={resolveImageSrc(draftImage)}
              alt="待保存的笔记图片"
              className="max-h-40 rounded border border-[var(--border)]"
            />
            <button
              type="button"
              onClick={() => {
                setDraftImage(undefined);
                if (composerFileRef.current) composerFileRef.current.value = "";
              }}
              className="absolute -right-2 -top-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--bg)] text-xs shadow ring-1 ring-[var(--border)]"
              aria-label="移除图片"
            >
              ✕
            </button>
          </div>
        )}
        <div className="flex items-center justify-between">
          <label className="cursor-pointer text-xs text-[var(--fg-soft)] hover:text-[var(--accent)]">
            <input
              ref={composerFileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handlePickDraftImage}
            />
            📎 {draftImage ? "替换图片" : "添加图片"}
          </label>
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-md border border-[var(--border)] px-3 py-1 text-xs transition hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            保存
          </button>
        </div>
      </form>
    </section>
  );
}
