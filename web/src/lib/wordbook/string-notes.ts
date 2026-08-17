/**
 * "串词笔记" (string-word notes) — group a handful of related lemmas
 * together with a free-form paragraph that mentions them, so the user
 * can memorise them as a cluster instead of one-by-one.
 *
 * Shape summary
 * -------------
 *   StringNote {
 *     id:         stable uuid
 *     words[]:    the lemmas being tied together, IN INPUT ORDER. They must
 *                 all exist in the dictionary (validated by the UI at
 *                 create/edit time — this layer stores whatever it's given).
 *     paragraph:  free-form text, may contain any of the words in `words`.
 *                 The detail modal renders occurrences as clickable links.
 *     image?:     optional data-URL (JPEG, downscaled ≤1200px), same
 *                 compression pipeline as NotebookNotesPanel.
 *     group?:     optional IELTS group name (matches WordbookEntry.group).
 *                 Enables the wordbook filter bar to hide notes that don't
 *                 belong to the currently-filtered group.
 *   }
 *
 * Storage
 * -------
 * Records live in IndexedDB under IDB_KEY. We mirror the exact pattern used
 * by wordbook/local.ts wordNotes:
 *   - module-level in-memory cache backs synchronous readers
 *   - `hydrateStringNotesFromIdb()` runs once at boot (called from
 *     SyncProvider) to fill the cache
 *   - writes flip the cache immediately, fire an event, and persist to IDB
 *     as a fire-and-forget background op
 *
 * The event name `get:string-notes-change` is registered with
 * `EVENT_TO_SHARD` in lib/sync/cloud.ts so every write also triggers a
 * debounced cloud push under the "stringNotes" shard.
 */

import { idbGet, idbSet } from "@/lib/storage/idb";

const IDB_KEY = "get:string-notes:v1";

/** Single note record. `id` is stable across edits; `updatedAt` is the tie
 *  breaker for cloud last-write-wins merges. */
export interface StringNote {
  id: string;
  /** Lemmas the note ties together, in the order the user typed them. */
  words: string[];
  /** Free-form paragraph. Words in `words[]` that appear here are rendered
   *  as clickable links in the detail modal. */
  paragraph: string;
  /** Optional attached image (data URL, JPEG, ≤1200px). */
  image?: string;
  /** Optional IELTS group name (matches WordbookEntry.group). */
  group?: string;
  createdAt: string;
  updatedAt: string;
}

type Store = Record<string, StringNote>; // id → note

// ---------------------------------------------------------------------------
// In-memory cache + hydration
// ---------------------------------------------------------------------------

let cache: Store = {};
let hydrated = false;
let hydratePromise: Promise<void> | null = null;

/**
 * Fill the in-memory cache from IndexedDB. Idempotent — subsequent calls
 * return the same resolved promise. SSR-safe (no-op on the server).
 */
export async function hydrateStringNotesFromIdb(): Promise<void> {
  if (typeof window === "undefined") {
    hydrated = true;
    return;
  }
  if (hydrated) return;
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const fromIdb = await idbGet<Store>(IDB_KEY);
      if (fromIdb && typeof fromIdb === "object") {
        cache = fromIdb;
      }
    } catch (e) {
      console.error("[string-notes] hydrate: idbGet failed", e);
    }
    hydrated = true;
  })();
  return hydratePromise;
}

/**
 * Sync raw-read used by the cloud-sync layer. Returns the same reference
 * the cache holds so callers must NOT mutate it in place.
 */
export function readStore(): Store {
  return cache;
}

/**
 * Sync raw-write used by the cloud-sync layer (post-merge write-back).
 * Also dispatches the change event so open UI re-renders from the new state.
 */
export function writeStore(store: Store): void {
  cache = store;
  if (typeof window === "undefined") return;
  void idbSet(IDB_KEY, store).catch((e) => {
    console.error("[string-notes] writeStore idbSet failed", e);
  });
  window.dispatchEvent(new CustomEvent("get:string-notes-change"));
}

function makeUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `sn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Public CRUD
// ---------------------------------------------------------------------------

/** All notes, newest-updated first. */
export function listNotes(): StringNote[] {
  return Object.values(cache).sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : -1,
  );
}

export function getNote(id: string): StringNote | null {
  return cache[id] ?? null;
}

export interface NewNoteInput {
  words: string[];
  paragraph: string;
  image?: string;
  group?: string;
}

export function addNote(input: NewNoteInput): StringNote {
  const now = new Date().toISOString();
  const note: StringNote = {
    id: makeUuid(),
    words: normaliseWords(input.words),
    paragraph: input.paragraph.trim(),
    image: input.image,
    group: input.group?.trim() ? input.group.trim() : undefined,
    createdAt: now,
    updatedAt: now,
  };
  const next: Store = { ...cache, [note.id]: note };
  writeStore(next);
  return note;
}

export function updateNote(
  id: string,
  patch: Partial<NewNoteInput>,
): StringNote | null {
  const existing = cache[id];
  if (!existing) return null;
  const next: StringNote = {
    ...existing,
    words: patch.words ? normaliseWords(patch.words) : existing.words,
    paragraph:
      patch.paragraph !== undefined ? patch.paragraph.trim() : existing.paragraph,
    // `image` is a three-way toggle: undefined = keep, null-ish empty = clear,
    // any string = replace. We use `patch.image === undefined` to distinguish
    // "not touched" from "clear it".
    image:
      patch.image === undefined
        ? existing.image
        : patch.image
          ? patch.image
          : undefined,
    group:
      patch.group === undefined
        ? existing.group
        : patch.group?.trim()
          ? patch.group.trim()
          : undefined,
    updatedAt: new Date().toISOString(),
  };
  writeStore({ ...cache, [id]: next });
  return next;
}

export function deleteNote(id: string): boolean {
  if (!cache[id]) return false;
  const next = { ...cache };
  delete next[id];
  writeStore(next);
  return true;
}

/**
 * Merge helper used by the cloud-sync layer. Per-id last-write-wins by
 * `updatedAt`, matching the notebook / wordbook conventions.
 */
export function mergeStringNotes(local: Store, remote: Store): Store {
  const merged: Store = { ...local };
  for (const [id, remoteNote] of Object.entries(remote)) {
    const localNote = merged[id];
    if (!localNote || remoteNote.updatedAt > localNote.updatedAt) {
      merged[id] = remoteNote;
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a user-supplied word list:
 *   - trim each entry
 *   - drop empties
 *   - lower-case (dictionary keys are stored lower-cased, and the wordbook
 *     stores lemmas lower-cased too)
 *   - dedupe while preserving order (first occurrence wins)
 *
 * We keep this purely mechanical — dictionary existence checks live in the
 * UI layer, which is the only place with an async `lookup()` at hand.
 */
export function normaliseWords(input: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const w = raw.trim().toLowerCase();
    if (!w) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}
