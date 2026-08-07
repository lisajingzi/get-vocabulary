"use client";

/**
 * <DistinctionRefs /> — cross-reference block for the word detail page.
 *
 * Scans localStorage for every distinction notebook entry that mentions
 * the current headword and lists them as clickable badges. Clicking one
 * opens the distinction editor in a new tab so the user's reading flow
 * on the word page isn't interrupted.
 *
 * Kept as its own component (rather than inlined into WordDetailView) so
 * the effect + change subscription stay isolated and the block can be
 * dropped into both the "canonical" and "not-found" branches with a
 * single JSX line.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  listDistinctionsContaining,
  type NotebookEntry,
} from "@/lib/notebook/local";

interface Props {
  /** The word to look up. Case / whitespace normalisation is handled by
   *  the storage helper — pass whatever the user typed. */
  word: string;
}

export default function DistinctionRefs({ word }: Props) {
  const [items, setItems] = useState<NotebookEntry[]>([]);

  useEffect(() => {
    function refresh() {
      setItems(listDistinctionsContaining(word));
    }
    refresh();
    // Live-refresh when the user edits a distinction in another tab / after
    // navigating back from the editor. Same event bus as the list page.
    window.addEventListener("get:notebook-change", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("get:notebook-change", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [word]);

  if (items.length === 0) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-[var(--fg-soft)]">词组辨析</h2>
      <ul className="flex flex-wrap gap-2">
        {items.map((it) => (
          <li key={it.id}>
            <Link
              href={`/notebook/distinction/${encodeURIComponent(it.id)}`}
              target="_blank"
              rel="noopener noreferrer"
              title={it.text || "未命名辨析"}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-3 py-1 text-sm text-[var(--fg-soft)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              {it.text || "未命名辨析"}
              <span aria-hidden className="text-xs">↗</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
