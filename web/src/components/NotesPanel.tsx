"use client";

/**
 * <NotesPanel /> — per-lemma note list with text + image attachments.
 *
 * Behaviour spec (from the product brief):
 *   - "支持文本输入或图片上传，保存后将会一直出现在该单词展示页，可持续更新"
 *   - Editable inline (no separate dialog) — fewer clicks for self-use.
 *   - Newest first; can edit / delete each note.
 *
 * Storage (V1): localStorage via `lib/wordbook/local`. Image is held as a
 * base64 data URL. Day 3b will swap the image storage for Supabase Storage
 * uploads, but the public API of this component won't change.
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
  updateNote,
  type WordNote,
} from "@/lib/wordbook/local";

interface Props {
  lemma: string;
  /**
   * When true, the composer enforces selecting a part-of-speech *before*
   * the very first save can go through. Used by the not-found flow where
   * the user is creating an entry the dictionary doesn't carry, so we need
   * them to tell us how to classify it in 单词本. Default: false (normal
   * dictionary words already have a pos snapshot).
   */
  requirePosOnFirstSave?: boolean;
  /**
   * The currently-stored pos for this lemma, if any. Drives two things:
   *   1. Whether the pos picker is in "first-time required" mode (undefined)
   *      vs. "already chosen, optional edit" mode (defined).
   *   2. The pre-selected chip in the picker.
   */
  initialPos?: string;
  /**
   * Called when the user submits the very FIRST note for a lemma that has
   * no wordbook entry yet (i.e. requirePosOnFirstSave + no existing entry).
   * The parent is responsible for actually creating the wordbook entry
   * (recordLookup) — the panel itself only owns the notes store. The note
   * itself has already been persisted by the time this fires.
   */
  onFirstSave?: (info: { pos: string }) => void;
  /**
   * Called whenever the user edits the pos chip *after* the entry exists.
   * Lets the parent persist the change (setPos) without coupling the panel
   * to the wordbook module. Only relevant when requirePosOnFirstSave=true.
   */
  onPosChange?: (pos: string) => void;
}

/** Allowed pos tokens. Stored values match the strings the wordbook page's
 *  `matchPos` checks against (`includes("verb")` etc.) so the user's choice
 *  flows straight into the existing filter. */
export const POS_PICKER_OPTIONS: ReadonlyArray<{
  value: string;
  short: string;
  label: string;
}> = [
  { value: "noun", short: "n.", label: "名词" },
  { value: "verb", short: "v.", label: "动词" },
  { value: "adjective", short: "adj.", label: "形容词" },
  { value: "adverb", short: "adv.", label: "副词" },
  { value: "preposition", short: "prep.", label: "介词" },
  { value: "conjunction", short: "conj.", label: "连词" },
  { value: "pronoun", short: "pron.", label: "代词" },
  { value: "other", short: "其他", label: "其他" },
];

/** Down-scale uploaded images so localStorage doesn't blow up.
 *  Caps the longest edge at 1200px and re-encodes as JPEG q=0.85 — this turns
 *  a 4 MB phone photo into ~150 KB which we can comfortably stash inline. */
async function fileToCompressedDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("仅支持图片文件");
  }
  // Read into an Image element first so we can resize via canvas.
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = objectUrl;
    });
    const MAX = 1200;
    let { width, height } = img;
    if (width > MAX || height > MAX) {
      const ratio = Math.min(MAX / width, MAX / height);
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export default function NotesPanel({
  lemma,
  requirePosOnFirstSave = false,
  initialPos,
  onFirstSave,
  onPosChange,
}: Props) {
  const [notes, setNotes] = useState<WordNote[]>([]);
  const [draft, setDraft] = useState("");
  const [draftImage, setDraftImage] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [editImage, setEditImage] = useState<string | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editFileRef = useRef<HTMLInputElement>(null);

  // When we're in "ask the user for a pos" mode, this holds the current
  // selection. Seeded from initialPos so already-classified words show their
  // chip pre-checked. Empty string == nothing chosen yet.
  const normalizedInitial = (initialPos ?? "").toLowerCase();
  const matchedInitial =
    POS_PICKER_OPTIONS.find((o) => normalizedInitial.includes(o.value))?.value ?? "";
  const [selectedPos, setSelectedPos] = useState<string>(matchedInitial);

  // Keep selectedPos in sync if the parent's initialPos changes (e.g. the
  // wordbook entry was created, parent re-rendered with the new pos).
  useEffect(() => {
    setSelectedPos(matchedInitial);
  }, [matchedInitial]);

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

  // ---- handlers ---------------------------------------------------------

  // Whether to render and enforce the pos picker on the composer.
  const showPosPicker = requirePosOnFirstSave;
  // True until the parent persists a pos for this lemma. "Required" means
  // saving is blocked until selectedPos is non-empty.
  const posRequired = showPosPicker && !initialPos;

  function handlePosPick(value: string) {
    setSelectedPos(value);
    // If the entry already exists, propagate the change immediately so the
    // wordbook reflects the new classification without waiting for a save.
    if (initialPos && onPosChange && value && value !== matchedInitial) {
      onPosChange(value);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body && !draftImage) return;
    if (posRequired && !selectedPos) return; // guarded by disabled state too
    const isFirstSave = requirePosOnFirstSave && !initialPos;
    addNote(lemma, body, draftImage);
    setDraft("");
    setDraftImage(undefined);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (isFirstSave && onFirstSave && selectedPos) {
      onFirstSave({ pos: selectedPos });
    }
  }

  async function handlePickImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const url = await fileToCompressedDataUrl(file);
      setDraftImage(url);
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert((err as Error).message);
    }
  }

  function startEdit(note: WordNote) {
    setEditing(note.id);
    setEditBody(note.body);
    setEditImage(note.image);
  }

  async function handlePickEditImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const url = await fileToCompressedDataUrl(file);
      setEditImage(url);
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

  // ---- render -----------------------------------------------------------

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium uppercase tracking-wide text-[var(--accent)]">
        笔记
      </h2>

      {/* New-note composer */}
      <form
        onSubmit={handleSubmit}
        className="space-y-2 rounded-lg border border-[var(--border)] p-3"
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`关于 ${lemma} 的笔记…（可同时附图）`}
          rows={3}
          className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-[var(--fg-soft)]"
        />
        {draftImage && (
          <div className="relative inline-block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={draftImage}
              alt="待保存的笔记图片"
              className="max-h-40 rounded border border-[var(--border)]"
            />
            <button
              type="button"
              onClick={() => setDraftImage(undefined)}
              className="absolute -right-2 -top-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--bg)] text-xs shadow ring-1 ring-[var(--border)]"
              aria-label="移除图片"
            >
              ✕
            </button>
          </div>
        )}
        {showPosPicker && (
          <div className="space-y-1.5 border-t border-[var(--border)] pt-2">
            <p className="text-[11px] text-[var(--fg-soft)]">
              {posRequired
                ? "选择词性（用于在单词本里分类，必选）"
                : "词性（点击可修改）"}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {POS_PICKER_OPTIONS.map((o) => {
                const active = selectedPos === o.value;
                return (
                  <button
                    type="button"
                    key={o.value}
                    onClick={() => handlePosPick(o.value)}
                    title={o.label}
                    className={[
                      "rounded-full border px-2.5 py-0.5 text-xs transition",
                      active
                        ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                        : "border-[var(--border)] text-[var(--fg-soft)] hover:border-[var(--accent)] hover:text-[var(--fg)]",
                    ].join(" ")}
                  >
                    <span className="font-medium">{o.short}</span>
                    <span className="ml-1 text-[10px] opacity-80">{o.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="flex items-center justify-between">
          <label className="cursor-pointer text-xs text-[var(--fg-soft)] hover:text-[var(--accent)]">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handlePickImage}
            />
            📎 添加图片
          </label>
          <button
            type="submit"
            disabled={
              (!draft.trim() && !draftImage) ||
              (posRequired && !selectedPos)
            }
            title={
              posRequired && !selectedPos
                ? "请先选择词性，再保存第一条笔记"
                : undefined
            }
            className="rounded-md border border-[var(--border)] px-3 py-1 text-xs transition hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            保存
          </button>
        </div>
      </form>

      {/* Existing notes */}
      {notes.length === 0 ? (
        <p className="text-xs text-[var(--fg-soft)]">
          还没有笔记。在上方写一条吧。
        </p>
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => {
            const isEditing = editing === n.id;
            return (
              <li
                key={n.id}
                className="rounded-lg border border-[var(--border)] p-3"
              >
                {isEditing ? (
                  <div className="space-y-2">
                    <textarea
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                      rows={3}
                      className="w-full resize-none bg-transparent text-sm outline-none"
                    />
                    {editImage && (
                      <div className="relative inline-block">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={editImage}
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
                        src={n.image}
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
      )}
    </section>
  );
}
