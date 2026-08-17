"use client";

/**
 * <StringNotesSection /> — the "串词笔记" collapsible panel.
 *
 * Where it lives: at the top of /wordbook when `starredOnly === true` (the
 * "只看已标星" tab). Everywhere else in the app it stays hidden — the
 * feature is intentionally scoped to a study-focused surface.
 *
 * What it does:
 *   1. Renders a fold-out list of "string notes" the user has authored.
 *      A string note ties together a small set of dictionary lemmas
 *      (word1 / word2 / word3) with a free-form paragraph and optional
 *      image. Purpose: memorise groups of related words as a story
 *      instead of one-by-one.
 *   2. Filters the visible list by the same `group` + `ielts` filters the
 *      wordbook page is currently applying — so switching the top filter
 *      also narrows down which string notes you see, which matches the
 *      "只看标星词" mental model.
 *   3. New / edit modal: single-line word input (comma OR whitespace
 *      separated), each token validated against the offline dictionary
 *      (`lookup`) — unknown tokens are shown in red and block save.
 *   4. Detail modal: renders the paragraph with occurrences of the note's
 *      words auto-linked to their /word/<lemma> detail pages. Uses word
 *      boundaries so "run" doesn't highlight "running".
 *
 * Persistence: writes go through lib/wordbook/string-notes which is wired
 * up to the "stringNotes" cloud sync shard via SyncProvider.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  addNote,
  deleteNote,
  listNotes,
  type StringNote,
  updateNote,
} from "@/lib/wordbook/string-notes";
import { getEntry } from "@/lib/wordbook/local";
import { lookup } from "@/lib/dict";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  /** Available group names (drawn from the wordbook's IELTS import groups),
   *  offered in the "所属词组" picker of the editor modal. */
  groupOptions: string[];
  /** Currently-selected group filter on the wordbook page.
   *  "all" → show every note; a specific name → only that group;
   *  "__none__" → show notes with no group assigned. */
  groupFilter: "all" | string;
}

// ---------------------------------------------------------------------------
// LocalStorage-backed remember-my-fold-state helpers
// ---------------------------------------------------------------------------

const EXPANDED_KEY = "get:string-notes-expanded:v1";

function readExpanded(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeExpanded(v: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(EXPANDED_KEY, v ? "1" : "0");
  } catch {
    /* quota / disabled — non-fatal, fold state just doesn't persist. */
  }
}

// ---------------------------------------------------------------------------
// Image compression pipeline (identical to NotebookNotesPanel so images
// round-trip the same regardless of where they were authored).
// ---------------------------------------------------------------------------

async function fileToCompressedDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("仅支持图片文件");
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new window.Image();
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

// ---------------------------------------------------------------------------
// Word-tokenising for the editor's word input
// ---------------------------------------------------------------------------

/**
 * Split the free-form "words" input into candidate lemma tokens.
 * Split on commas (中英文都算) and whitespace. We keep case-insensitive
 * behavior downstream — the dictionary and wordbook both key on
 * lower-cased lemmas.
 */
function tokeniseWordsInput(raw: string): string[] {
  return raw
    .split(/[,，、\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function matchesGroup(note: StringNote, filter: "all" | string): boolean {
  if (filter === "all") return true;
  const g = note.group?.trim();
  if (filter === "__none__") return !g;
  return g === filter;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function StringNotesSection({
  groupOptions,
  groupFilter,
}: Props) {
  const [notes, setNotes] = useState<StringNote[]>([]);
  const [expanded, setExpanded] = useState<boolean>(false);
  const [editing, setEditing] = useState<StringNote | null>(null);
  const [creating, setCreating] = useState<boolean>(false);
  const [viewing, setViewing] = useState<StringNote | null>(null);

  // Restore fold state from localStorage on mount (SSR-safe deferral).
  useEffect(() => {
    setExpanded(readExpanded());
  }, []);

  const refresh = useCallback(() => {
    setNotes(listNotes());
  }, []);

  useEffect(() => {
    refresh();
    function onChange() {
      refresh();
    }
    window.addEventListener("get:string-notes-change", onChange);
    return () =>
      window.removeEventListener("get:string-notes-change", onChange);
  }, [refresh]);

  const visible = useMemo(
    () => notes.filter((n) => matchesGroup(n, groupFilter)),
    [notes, groupFilter],
  );

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    writeExpanded(next);
  }

  function openCreate() {
    setCreating(true);
  }

  function openEdit(note: StringNote) {
    setEditing(note);
    setViewing(null);
  }

  function handleDeleteFromDetail(note: StringNote) {
    if (
      typeof window !== "undefined" &&
      !window.confirm("确定删除这条串词笔记？")
    ) {
      return;
    }
    deleteNote(note.id);
    setViewing(null);
  }

  return (
    <section className="rounded-lg border border-[var(--border)]">
      {/* Header — click anywhere on the strip toggles the panel. The
          "新增" button stops propagation so tapping it never collapses
          the section unexpectedly. */}
      <div
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        className="flex cursor-pointer items-center justify-between gap-3 px-4 py-2.5"
      >
        <div className="flex items-center gap-2 text-sm">
          <span
            aria-hidden
            className={[
              "inline-block text-xs text-[var(--fg-soft)] transition-transform",
              expanded ? "rotate-90" : "",
            ].join(" ")}
          >
            ▶
          </span>
          <span className="font-medium">串词笔记</span>
          <span className="text-xs text-[var(--fg-soft)]">
            · {visible.length}
          </span>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            // If the panel is folded, opening the modal without expanding
            // it first is confusing — a save would then hide behind a
            // still-folded header. Auto-expand.
            if (!expanded) {
              setExpanded(true);
              writeExpanded(true);
            }
            openCreate();
          }}
          className="rounded-md border border-[var(--border)] px-2.5 py-0.5 text-xs text-[var(--fg-soft)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          ✏️ 新增串词
        </button>
      </div>

      {expanded && (
        <div className="border-t border-[var(--border)]">
          {visible.length === 0 ? (
            <p className="px-4 py-3 text-xs text-[var(--fg-soft)]">
              还没有串词笔记。把几个相关的单词编成一段话，一起记住吧。
            </p>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {visible.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => setViewing(n)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition hover:bg-[var(--bg-soft)]"
                  >
                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate text-sm font-medium"
                        title={n.words.join(" / ")}
                      >
                        {n.words.join(" / ") || (
                          <span className="text-[var(--fg-soft)]">
                            （无词条）
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--fg-soft)]">
                        <span>{n.words.length} 个词</span>
                        {n.group && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="truncate" title={n.group}>
                              {n.group}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <span
                      aria-hidden
                      className="shrink-0 text-xs text-[var(--fg-soft)]"
                    >
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Editor modal — shared between "create" and "edit" flows. */}
      {(creating || editing) && (
        <StringNoteEditor
          initial={editing ?? null}
          groupOptions={groupOptions}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      {/* Detail modal — shows the paragraph with clickable words + image. */}
      {viewing && (
        <StringNoteDetail
          note={viewing}
          onClose={() => setViewing(null)}
          onEdit={() => openEdit(viewing)}
          onDelete={() => handleDeleteFromDetail(viewing)}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// <StringNoteEditor /> — modal used for both create and edit.
// ---------------------------------------------------------------------------

interface EditorProps {
  initial: StringNote | null;
  groupOptions: string[];
  onClose: () => void;
}

/**
 * Result of validating one word token against the dictionary.
 * `resolved` is the lemma we should actually store — dictionary aliases
 * (e.g. "abandoned" → "abandon") get canonicalised so the paragraph
 * highlighter matches whatever the user typed originally.
 */
interface WordCheck {
  input: string;
  ok: boolean;
  resolved?: string;
}

function StringNoteEditor({ initial, groupOptions, onClose }: EditorProps) {
  const isEdit = !!initial;

  const [wordsRaw, setWordsRaw] = useState<string>(
    initial?.words.join(", ") ?? "",
  );
  const [paragraph, setParagraph] = useState<string>(initial?.paragraph ?? "");
  const [image, setImage] = useState<string | undefined>(initial?.image);
  const [group, setGroup] = useState<string>(initial?.group ?? "");
  const [customGroup, setCustomGroup] = useState<string>("");
  const [checks, setChecks] = useState<WordCheck[]>([]);
  const [checking, setChecking] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Re-validate word tokens (debounced) as the user types.
  //
  // Validation rule: a token is accepted if it exists in EITHER
  //   (a) the user's wordbook — covers custom / imported entries that may
  //       not appear in the offline dictionary, or
  //   (b) the offline dictionary — covers everything else.
  // Wordbook is consulted first because it's the authoritative source of
  // "words the user has actually recorded"; its lemma (canonical spelling
  // as stored) becomes the resolved value we persist.
  useEffect(() => {
    const tokens = tokeniseWordsInput(wordsRaw);
    if (tokens.length === 0) {
      setChecks([]);
      return;
    }
    let cancelled = false;
    setChecking(true);
    const t = setTimeout(async () => {
      const results = await Promise.all(
        tokens.map(async (tok): Promise<WordCheck> => {
          // (a) wordbook — synchronous, in-memory
          const inBook = getEntry(tok);
          if (inBook) {
            return { input: tok, ok: true, resolved: inBook.lemma };
          }
          // (b) offline dictionary — async
          try {
            const hit = await lookup(tok);
            if (hit) return { input: tok, ok: true, resolved: hit.lemma };
            return { input: tok, ok: false };
          } catch {
            return { input: tok, ok: false };
          }
        }),
      );
      if (!cancelled) {
        setChecks(results);
        setChecking(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [wordsRaw]);

  async function handlePickImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const url = await fileToCompressedDataUrl(file);
      setImage(url);
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert((err as Error).message);
    }
  }

  // A token is "invalid" when it's non-empty AND we've fully checked it
  // AND the dict lookup returned nothing. Fresh (unchecked) tokens are
  // treated as pending, not invalid.
  const invalidTokens = useMemo(
    () => checks.filter((c) => !c.ok).map((c) => c.input),
    [checks],
  );
  const hasAtLeastOneWord = checks.length > 0 && checks.every((c) => c.ok);
  const canSave =
    hasAtLeastOneWord &&
    paragraph.trim().length > 0 &&
    !checking &&
    !saving;

  // "所属词组" resolution: `group` is either "" (unset), "__custom__" (use
  // the customGroup textbox) or a value from the dropdown. The final
  // string that gets persisted is derived at submit time.
  const finalGroup =
    group === "__custom__" ? customGroup.trim() : group.trim();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    // Persist the RESOLVED lemmas rather than the raw input, so cross-
    // references (paragraph highlighter, wordbook lookup) all agree on
    // the canonical form. `normaliseWords` in the data layer will
    // additionally lowercase + dedupe.
    const resolvedWords = checks
      .filter((c) => c.ok && c.resolved)
      .map((c) => c.resolved as string);
    try {
      if (initial) {
        updateNote(initial.id, {
          words: resolvedWords,
          paragraph,
          image,
          group: finalGroup || undefined,
        });
      } else {
        addNote({
          words: resolvedWords,
          paragraph,
          image,
          group: finalGroup || undefined,
        });
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  // Close on Esc for keyboard users.
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? "编辑串词笔记" : "新增串词笔记"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 shadow-lg"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {isEdit ? "编辑串词笔记" : "新增串词笔记"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="text-lg text-[var(--fg-soft)] transition hover:text-[var(--fg)]"
          >
            ×
          </button>
        </div>

        {/* Words */}
        <label className="block space-y-1">
          <span className="text-xs font-medium text-[var(--fg-soft)]">
            单词（用逗号或空格分隔）
          </span>
          <input
            type="text"
            value={wordsRaw}
            onChange={(e) => setWordsRaw(e.target.value)}
            placeholder="例如：affect, effect, impact"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
          />
        </label>
        {/* Per-token validation feedback. Green = in dict; red = not in
            dict → save disabled. */}
        {checks.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {checks.map((c) => (
            <span
                key={c.input}
                title={c.ok ? `已收录：${c.resolved}` : "未在词库中"}
                className={[
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]",
                  c.ok
                    ? "border border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]"
                    : "border border-red-400/40 bg-red-500/10 text-red-500",
                ].join(" ")}
              >
                {c.input}
                {c.ok ? " ✓" : " ✗"}
              </span>
            ))}
          </div>
        )}
        {invalidTokens.length > 0 && (
          <p className="mt-1.5 text-[11px] text-red-500">
            以下词未在词库中，请修正或删除后再保存：
            {invalidTokens.join("、")}
          </p>
        )}

        {/* Paragraph */}
        <label className="mt-3 block space-y-1">
          <span className="text-xs font-medium text-[var(--fg-soft)]">
            串词段落
          </span>
          <textarea
            value={paragraph}
            onChange={(e) => setParagraph(e.target.value)}
            rows={5}
            placeholder="把这些词编进一段话或一个故事里，段落中出现的词会自动变成可点击的链接。"
            className="w-full resize-y rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-sm leading-6 outline-none focus:border-[var(--accent)]"
          />
        </label>

        {/* Image */}
        <div className="mt-3 space-y-1">
          <span className="text-xs font-medium text-[var(--fg-soft)]">
            配图（可选）
          </span>
          {image && (
            <div className="relative inline-block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image}
                alt="串词笔记配图"
                className="max-h-40 rounded border border-[var(--border)]"
              />
              <button
                type="button"
                onClick={() => {
                  setImage(undefined);
                  if (fileRef.current) fileRef.current.value = "";
                }}
                className="absolute -right-2 -top-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--bg)] text-xs shadow ring-1 ring-[var(--border)]"
                aria-label="移除图片"
              >
                ✕
              </button>
            </div>
          )}
          <label className="block cursor-pointer text-xs text-[var(--fg-soft)] hover:text-[var(--accent)]">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handlePickImage}
            />
            📎 {image ? "替换图片" : "添加图片"}
          </label>
        </div>

        {/* Group */}
        <div className="mt-3 space-y-1">
          <span className="text-xs font-medium text-[var(--fg-soft)]">
            所属词组（可选，用于筛选）
          </span>
          <select
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1.5 text-sm outline-none"
          >
            <option value="">未分组</option>
            {groupOptions.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
            <option value="__custom__">自定义…</option>
          </select>
          {group === "__custom__" && (
            <input
              type="text"
              value={customGroup}
              onChange={(e) => setCustomGroup(e.target.value)}
              placeholder="输入词组名"
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
            />
          )}
        </div>

        {/* Actions */}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--border)] px-3 py-1 text-xs text-[var(--fg-soft)] transition hover:text-[var(--fg)]"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={!canSave}
            className="rounded-md border border-[var(--accent)] bg-[var(--accent)] px-3 py-1 text-xs text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "保存中…" : isEdit ? "保存" : "创建"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// <StringNoteDetail /> — read-only modal with clickable-word paragraph.
// ---------------------------------------------------------------------------

interface DetailProps {
  note: StringNote;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function StringNoteDetail({ note, onClose, onEdit, onDelete }: DetailProps) {
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="串词笔记详情"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 shadow-lg"
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold" title={note.words.join(" / ")}>
              {note.words.join(" / ")}
            </h2>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--fg-soft)]">
              <span>{note.words.length} 个词</span>
              {note.group && (
                <>
                  <span aria-hidden>·</span>
                  <span>{note.group}</span>
                </>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="text-lg text-[var(--fg-soft)] transition hover:text-[var(--fg)]"
          >
            ×
          </button>
        </div>

        {note.image && (
          <div className="mb-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={note.image}
              alt=""
              className="max-h-80 w-full rounded border border-[var(--border)] object-contain"
            />
          </div>
        )}

        <div className="whitespace-pre-wrap text-sm leading-7">
          <HighlightedParagraph text={note.paragraph} words={note.words} />
        </div>

        <div className="mt-4 flex items-center justify-end gap-3 text-xs">
          <button
            type="button"
            onClick={onDelete}
            className="text-[var(--fg-soft)] transition hover:text-red-500"
          >
            删除
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="rounded-md border border-[var(--border)] px-3 py-1 transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            编辑
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paragraph highlighter
// ---------------------------------------------------------------------------

/**
 * Render `text` with each occurrence of any lemma in `words` turned into
 * a clickable link to /word/<lemma>. Matches whole words only (JS regex
 * \b works fine for ASCII lemmas, which is all our dictionary contains),
 * case-insensitive.
 *
 * Impl detail: we sort `words` by length DESC before building the regex,
 * so overlapping candidates like "in spite of" match before "of". Regex
 * escape for safety even though lemmas are ASCII — cheap and future-proof.
 */
function HighlightedParagraph({
  text,
  words,
}: {
  text: string;
  words: string[];
}) {
  const parts = useMemo(() => {
    if (!text) return [];
    const cleaned = Array.from(new Set(words.map((w) => w.trim()).filter(Boolean)));
    if (cleaned.length === 0) return [{ kind: "text" as const, value: text }];
    cleaned.sort((a, b) => b.length - a.length);
    const escaped = cleaned.map((w) =>
      w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    // \b won't help for multi-word phrases with spaces inside them, so we
    // fall back to a lookaround for any-non-letter boundary. Works across
    // punctuation ("run.", "run,", " run ").
    const re = new RegExp(
      `(?<![A-Za-z])(${escaped.join("|")})(?![A-Za-z])`,
      "gi",
    );
    const out: Array<
      { kind: "text"; value: string } | { kind: "link"; value: string; lemma: string }
    > = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) {
        out.push({ kind: "text", value: text.slice(last, m.index) });
      }
      const matched = m[1];
      // Map back to the canonical stored lemma (case-preserved from the
      // note's word list). This ensures the href points at whatever
      // dictionary key we stored — which is already lower-cased by the
      // data layer's normaliseWords.
      const canonical =
        cleaned.find((w) => w.toLowerCase() === matched.toLowerCase()) ??
        matched.toLowerCase();
      out.push({ kind: "link", value: matched, lemma: canonical });
      last = m.index + matched.length;
    }
    if (last < text.length) {
      out.push({ kind: "text", value: text.slice(last) });
    }
    return out;
  }, [text, words]);

  return (
    <>
      {parts.map((p, i) =>
        p.kind === "text" ? (
          <span key={i}>{p.value}</span>
        ) : (
          <a
            key={i}
            href={`/word/${encodeURIComponent(p.lemma)}?from=wordbook`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 decoration-[var(--accent)] text-[var(--accent)] hover:opacity-80"
          >
            {p.value}
          </a>
        ),
      )}
    </>
  );
}
