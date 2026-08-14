"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Compact "current / total" page indicator. Clicking the current-page number
 * turns it into an inline input so the user can jump straight to page N
 * without mashing the prev/next arrows.
 *
 * Behaviour:
 *   - Click the number → editable input, pre-selected for quick overwrite.
 *   - Enter / blur     → commit (clamped to [1, totalPages]).
 *   - Escape           → cancel, restore the previously shown number.
 *   - Invalid / empty  → cancel (same as Escape).
 *
 * Visual is intentionally unopinionated: the caller controls surrounding
 * layout (font size, colour, gaps). We only style the input so it inherits
 * the same tabular-nums look as the static text it replaces.
 */
export default function PageJumper({
  page,
  totalPages,
  onJump,
  className,
}: {
  page: number;
  totalPages: number;
  onJump: (next: number) => void;
  /** Optional extra classes applied to the wrapper (text-size / colour). */
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // When entering edit mode, seed the input with the current page and
  // auto-select so the user can just type the target page directly.
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  function commit() {
    const n = Number.parseInt(draft, 10);
    if (Number.isFinite(n) && n >= 1 && n <= totalPages) {
      if (n !== page) onJump(n);
    }
    setEditing(false);
  }

  function cancel() {
    setEditing(false);
  }

  if (!editing) {
    return (
      <span className={`tabular-nums ${className ?? ""}`}>
        <button
          type="button"
          onClick={() => {
            setDraft(String(page));
            setEditing(true);
          }}
          aria-label={`跳转到指定页，共 ${totalPages} 页`}
          title="点击输入页码跳转"
          className="cursor-pointer rounded px-1 -mx-1 hover:bg-[var(--border)]/40 hover:text-[var(--fg)] transition"
        >
          {page}
        </button>
        {" / "}
        {totalPages}
      </span>
    );
  }

  // Width heuristic: enough room for the largest possible page number.
  const widthCh = Math.max(2, String(totalPages).length);

  return (
    <span className={`tabular-nums inline-flex items-center gap-1 ${className ?? ""}`}>
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        aria-label="跳转到页码"
        className="rounded border border-[var(--border)] bg-transparent px-1 py-0 text-center tabular-nums outline-none focus:border-[var(--fg-soft)]"
        style={{ width: `${widthCh + 1.5}ch` }}
      />
      {" / "}
      {totalPages}
    </span>
  );
}
