"use client";

/**
 * <SearchBox /> — the home-page search entry with type-ahead suggestions.
 *
 * Behaviour spec (locked in product chat):
 *   - Suggest after the FIRST keystroke; debounce 80 ms (anything longer
 *     felt sluggish at 195k entries — the binary search is cheap).
 *   - Up to 8 suggestions, single-word lemmas first, then multi-word phrases.
 *   - ↑ / ↓ moves the highlight, Enter navigates to /word/<slug>, Esc closes.
 *   - Pressing Enter with NO highlight just navigates to the typed text;
 *     the detail page handles "not found" and offers a graceful fallback.
 *   - Click outside the box also closes the menu.
 *
 * The component is purely presentational + does its own data-fetching via
 * the `suggest()` helper. Parent page just drops it in.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  type ChangeEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { suggest } from "@/lib/dict";

interface Props {
  /** Optional initial value (used when the search page is opened with ?q=). */
  initial?: string;
  /** "lg" = home page (big input). "sm" = future header search bar. */
  size?: "lg" | "sm";
  autoFocus?: boolean;
}

export default function SearchBox({
  initial = "",
  size = "lg",
  autoFocus = false,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [value, setValue] = useState(initial);
  const [items, setItems] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Holds the timer id for debounced suggest() calls.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sticky header instance: when the route changes (e.g. user clicked a
  // suggestion or hit Enter and landed on /word/<x>), clear the input so the
  // box never looks stuck on a stale query and the next lookup starts fresh.
  useEffect(() => {
    setValue("");
    setItems([]);
    setActive(-1);
    setOpen(false);
  }, [pathname]);

  // ---- effects ----------------------------------------------------------

  // Debounced suggest fetch on every value change.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = value.trim();
    if (!q) {
      setItems([]);
      setActive(-1);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const next = await suggest(q, 8);
        setItems(next);
        // Never auto-highlight a suggestion. Pressing Enter must always
        // search for exactly what the user typed — otherwise typing
        // "arousal" and hitting Enter would silently jump to whatever the
        // first prefix match happens to be, which surprised users in
        // testing. Highlighting only kicks in via ↑/↓ keys.
        setActive(-1);
      } catch {
        setItems([]);
      }
    }, 80);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value]);

  // Close the dropdown when clicking elsewhere.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // ---- handlers ---------------------------------------------------------

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    setValue(e.target.value);
    setOpen(true);
  }

  function go(target: string) {
    const trimmed = target.trim().toLowerCase();
    if (!trimmed) return;
    setOpen(false);
    const dest = `/word/${encodeURIComponent(trimmed)}`;
    // If we're already sitting on the same /word/<slug> URL (common when
    // the sticky search box is reused on a detail page) router.push is a
    // no-op and the page appears "frozen". Force a refresh in that case so
    // the lookup re-runs and the user sees feedback either way.
    if (pathname === dest) {
      router.refresh();
    } else {
      router.push(dest);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length === 0) return;
      setOpen(true);
      setActive((prev) => (prev + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length === 0) return;
      setOpen(true);
      setActive((prev) => (prev <= 0 ? items.length - 1 : prev - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = active >= 0 && items[active] ? items[active] : value;
      go(target);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  // ---- render -----------------------------------------------------------

  const inputClass =
    size === "lg"
      ? "w-full bg-transparent text-base outline-none placeholder:text-[var(--fg-soft)]"
      : "w-full bg-transparent text-sm outline-none placeholder:text-[var(--fg-soft)]";
  const wrapperClass =
    size === "lg"
      ? "rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] px-4 py-3 transition focus-within:border-[var(--accent)]"
      : "rounded-md border border-[var(--border)] bg-[var(--bg-soft)] px-3 py-1.5 transition focus-within:border-[var(--accent)]";

  return (
    <div ref={wrapperRef} className="relative">
      <div className={wrapperClass}>
        <div className="flex items-center gap-2">
          <span className="text-[var(--fg-soft)]">🔍</span>
          <input
            type="text"
            inputMode="search"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus={autoFocus}
            placeholder="输入英文单词…"
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setOpen(true)}
            className={inputClass}
            aria-autocomplete="list"
          />
        </div>
      </div>

      {open && items.length > 0 && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-80 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--bg)] py-1 shadow-lg"
        >
          {items.map((lemma, idx) => {
            const isActive = idx === active;
            return (
              <li
                key={lemma}
                role="option"
                aria-selected={isActive}
                onMouseEnter={() => setActive(idx)}
                onMouseDown={(e) => {
                  // Prevent input blur, which would close the menu before
                  // onClick fires and cancel the navigation.
                  e.preventDefault();
                  go(lemma);
                }}
                className={[
                  "cursor-pointer px-4 py-2 text-sm",
                  isActive
                    ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "text-[var(--fg)]",
                ].join(" ")}
              >
                {/* Bold the matching prefix to make the type-ahead obvious. */}
                <span className="font-semibold">
                  {lemma.slice(0, value.trim().length)}
                </span>
                <span>{lemma.slice(value.trim().length)}</span>
              </li>
            );
          })}
          <li className="border-t border-[var(--border)]">
            <Link
              href={`/word/${encodeURIComponent(value.trim().toLowerCase())}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setOpen(false)}
              className="block px-4 py-2 text-xs text-[var(--fg-soft)] hover:text-[var(--accent)]"
            >
              直接查询「{value.trim()}」 →
            </Link>
          </li>
        </ul>
      )}
    </div>
  );
}
