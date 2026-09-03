"use client";

/**
 * <HideChineseToggle /> — the 🙈 header button that hides every Chinese
 * gloss / example translation across the app.
 *
 * Sits next to the sticky search box (see `RootLayout`). Reads and writes
 * the preference via the `lib/ui/hide-chinese` module, which broadcasts a
 * `get:hide-chinese-change` event so every subscriber re-renders in sync.
 *
 * Kept as a tiny, self-contained pill so the header stays uncluttered.
 * Emoji visually mirrors the state — 🙈 (hidden) vs 🙉 (showing).
 */

import { toggleHideChinese, useHideChinese } from "@/lib/ui/hide-chinese";

export default function HideChineseToggle() {
  const hidden = useHideChinese();

  return (
    <button
      type="button"
      onClick={() => toggleHideChinese()}
      aria-pressed={hidden}
      title={hidden ? "显示中文" : "关闭中文"}
      className={[
        "shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-full",
        "border text-base transition select-none",
        hidden
          ? "border-[var(--accent)] bg-[var(--accent-soft)]"
          : "border-[#9dbecd] bg-white/92 hover:bg-white",
      ].join(" ")}
    >
      <span aria-hidden>{hidden ? "🙈" : "🙉"}</span>
      <span className="sr-only">{hidden ? "显示中文" : "关闭中文"}</span>
    </button>
  );
}
