"use client";

/**
 * <NotesComposer /> — the "write a new note" form. Meant to live at the
 * bottom of the word detail page. Shares the same underlying note store
 * with <NotesReadOnlyList /> so a save here immediately appears in the
 * read-only list at the top.
 *
 * Also inherits the first-save pos-picker flow from the original
 * <NotesPanel /> — the not-found detail page uses `requirePosOnFirstSave`
 * to force the user to classify a dictionary-missing word before the
 * wordbook entry is created.
 */

import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { addNote } from "@/lib/wordbook/local";
import { POS_PICKER_OPTIONS } from "@/components/NotesPanel";

interface Props {
  lemma: string;
  requirePosOnFirstSave?: boolean;
  initialPos?: string;
  onFirstSave?: (info: { pos: string }) => void;
  onPosChange?: (pos: string) => void;
  /** Optional heading override; default "新增笔记". Set to "" to hide h2. */
  title?: string;
}

async function fileToCompressedDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("仅支持图片文件");
  }
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

export default function NotesComposer({
  lemma,
  requirePosOnFirstSave = false,
  initialPos,
  onFirstSave,
  onPosChange,
  title = "新增笔记",
}: Props) {
  const [draft, setDraft] = useState("");
  const [draftImage, setDraftImage] = useState<string | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const normalizedInitial = (initialPos ?? "").toLowerCase();
  const matchedInitial =
    POS_PICKER_OPTIONS.find((o) => normalizedInitial.includes(o.value))?.value ?? "";
  const [selectedPos, setSelectedPos] = useState<string>(matchedInitial);

  useEffect(() => {
    setSelectedPos(matchedInitial);
  }, [matchedInitial]);

  const showPosPicker = requirePosOnFirstSave;
  const posRequired = showPosPicker && !initialPos;

  function handlePosPick(value: string) {
    setSelectedPos(value);
    if (initialPos && onPosChange && value && value !== matchedInitial) {
      onPosChange(value);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body && !draftImage) return;
    if (posRequired && !selectedPos) return;
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

  return (
    <section className="space-y-3">
      {title && (
        <h2 className="text-sm font-medium uppercase tracking-wide text-[var(--accent)]">
          {title}
        </h2>
      )}
      <form
        onSubmit={handleSubmit}
        className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3"
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`关于 ${lemma} 的笔记…（可同时附图）`}
          rows={3}
          className="w-full resize-none bg-transparent text-base leading-9 caret-[var(--accent)] outline-none placeholder:text-[var(--fg-soft)]"
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
    </section>
  );
}
