"use client";

/**
 * Tiny dependency-free toast helper.
 *
 * Why hand-rolled? — A full library (react-hot-toast etc.) is overkill for
 * the 3-4 places the app needs lightweight feedback (wordbook status changes,
 * undo prompts). One DOM root, one queue, ~50 LOC of state.
 *
 * Public API:
 *   - <ToastHost />   — mount once near the root (we put it in layout).
 *   - toast(message)  — fire a transient message.
 *   - toast(message, { actionLabel, onAction, durationMs })
 *                     — show with an inline action button (used for "撤销").
 *
 * The host listens to a CustomEvent, so we don't need a context provider —
 * any module can `import { toast } from "@/components/Toast"` and call it,
 * including inside event handlers in deeply-nested children.
 */

import { useEffect, useState } from "react";

interface ToastOptions {
  /** Optional action label shown as a clickable button inside the toast. */
  actionLabel?: string;
  /** Callback invoked when the user clicks the action. Closes the toast. */
  onAction?: () => void;
  /** Auto-dismiss timeout in ms. Default 3000; 5000 if there's an action. */
  durationMs?: number;
}

interface ToastItem {
  id: number;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  durationMs: number;
}

const EVENT_NAME = "get:toast";

let nextId = 1;

export function toast(message: string, opts: ToastOptions = {}) {
  if (typeof window === "undefined") return;
  const detail: ToastItem = {
    id: nextId++,
    message,
    actionLabel: opts.actionLabel,
    onAction: opts.onAction,
    durationMs: opts.durationMs ?? (opts.actionLabel ? 5000 : 3000),
  };
  window.dispatchEvent(new CustomEvent<ToastItem>(EVENT_NAME, { detail }));
}

export default function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    function onPush(e: Event) {
      const ce = e as CustomEvent<ToastItem>;
      const item = ce.detail;
      setItems((prev) => [...prev, item]);
      // Auto-remove after the duration. Each toast has its own timer.
      window.setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== item.id));
      }, item.durationMs);
    }
    window.addEventListener(EVENT_NAME, onPush);
    return () => window.removeEventListener(EVENT_NAME, onPush);
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2 px-4">
      {items.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-4 py-2.5 text-sm shadow-lg"
        >
          <span>{t.message}</span>
          {t.actionLabel && t.onAction && (
            <button
              type="button"
              onClick={() => {
                t.onAction?.();
                setItems((prev) => prev.filter((x) => x.id !== t.id));
              }}
              className="rounded px-1.5 py-0.5 text-xs font-medium text-[var(--accent)] hover:bg-[var(--bg-soft)]"
            >
              {t.actionLabel}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
