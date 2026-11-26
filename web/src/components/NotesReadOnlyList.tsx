"use client";

/**
 * <NotesReadOnlyList /> — renders the existing notes for a lemma with
 * inline edit / delete affordances. NO composer. Meant to be placed
 * near the top of the detail page (right under 核心例句) so already-
 * saved thoughts are visible before the dictionary meaning takes over.
 *
 * Companion component: <NotesComposer /> handles the "write a new note"
 * flow and lives at the bottom of the page.
 *
 * Both components share the underlying `lib/wordbook/local` note store —
 * their views auto-refresh via the `get:notes-change` event.
 */

import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  deleteNote,
  listNotes,
  updateNote,
  type WordNote,
} from "@/lib/wordbook/local";
import { resolveImageSrc, uploadImageFile } from "@/lib/wordbook/image";

interface Props {
  lemma: string;
  /** Optional heading override; defaults to "笔记". Set to "" to hide the h2. */
  title?: string;
}

// Image attachment pipeline lives in lib/wordbook/image — downscale, upload
// to COS, store only a short reference in the note.

export default function NotesReadOnlyList({ lemma, title = "笔记" }: Props) {
  const [notes, setNotes] = useState<WordNote[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [editImage, setEditImage] = useState<string | undefined>(undefined);
  const editFileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    setNotes(listNotes(lemma));
  }, [lemma]);

  useEffect(() => {
    refresh();
    function onChange() {
      refresh();
    }
    window.addEventListener("get:notes-change", onChange);
    return () => window.removeEventListener("get:notes-change", onChange);
  }, [refresh]);

  function startEdit(n: WordNote) {
    setEditing(n.id);
    setEditBody(n.body);
    setEditImage(n.image);
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

  function commitEdit(id: string) {
    updateNote(lemma, id, { body: editBody.trim(), image: editImage ?? null });
    setEditing(null);
  }

  function cancelEdit() {
    setEditing(null);
    setEditBody("");
    setEditImage(undefined);
  }

  function handleDelete(id: string) {
    if (
      typeof window !== "undefined" &&
      !window.confirm("确定删除这条笔记？")
    ) {
      return;
    }
    deleteNote(lemma, id);
  }

  if (notes.length === 0) return null; // 空列表整体不渲染，交给 composer 承担 empty state

  return (
    <section className="space-y-3">
      {title && (
        <h2 className="text-sm font-medium uppercase tracking-wide text-[var(--accent)]">
          {title}
        </h2>
      )}
      <ul className="space-y-2">
        {notes.map((n) => {
          const isEditing = editing === n.id;
          return (
            <li
              key={n.id}
              className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3"
            >
              {isEditing ? (
                <div className="space-y-2">
                  <textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    rows={3}
                    className="w-full resize-none bg-transparent text-base leading-9 caret-[var(--accent)] outline-none"
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
                  <div className="flex items-center justify-end gap-2">
                    <label className="cursor-pointer text-xs text-[var(--fg-soft)] hover:text-[var(--accent)]">
                      <input
                        ref={editFileRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={handlePickEditImage}
                      />
                      📎 替换图片
                    </label>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      className="rounded-md px-2 py-1 text-xs text-[var(--fg-soft)] hover:text-[var(--fg)]"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={() => commitEdit(n.id)}
                      className="rounded-md border border-[var(--border)] px-2 py-1 text-xs transition hover:border-[var(--accent)]"
                    >
                      保存
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {n.body && (
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">
                      {n.body}
                    </p>
                  )}
                  {n.image && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={resolveImageSrc(n.image)}
                      alt=""
                      className="max-h-72 rounded border border-[var(--border)]"
                    />
                  )}
                  <div className="flex items-center justify-between text-[11px] text-[var(--fg-soft)]">
                    <span>
                      {new Date(n.createdAt).toLocaleString("zh-CN")}
                    </span>
                    <span className="space-x-3">
                      <button
                        type="button"
                        onClick={() => startEdit(n)}
                        className="hover:text-[var(--accent)]"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(n.id)}
                        className="hover:text-red-500"
                      >
                        删除
                      </button>
                    </span>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
