/**
 * Local-first storage for the "笔记本" (notebook) feature.
 *
 * The notebook holds two kinds of user-authored records:
 *   - "phrase"   → 短语，例如 "take advantage of"
 *   - "sentence" → 完整的句子
 *
 * Notebook entries are DELIBERATELY kept separate from the wordbook:
 *   - No 新朋友 / 老朋友 status, no Ebbinghaus level, no daily review queue.
 *   - Just "I want to remember this thing, and jot down my own notes on it."
 *
 * Sources:
 *   - "manual" → user typed the text + notes themselves.
 *   - "ai"     → user searched the phrase in the top search bar; DeepSeek
 *                produced a rich definition. The AI payload is CACHED on
 *                the entry (`ai` field) so re-visiting the phrase never
 *                re-hits the API — spec: "保存第一次AI生成的答案即可".
 *
 * Storage: two localStorage keys, mirroring wordbook/local.ts:
 *   - "get:notebook:v1"       → id → NotebookEntry
 *   - "get:notebook-notes:v1" → id → NotebookNote[]
 *
 * We use an internal `id` (slug for phrases, uuid for sentences) as the key
 * rather than the raw text, so:
 *   - Phrase URLs stay stable when the user edits capitalisation / spacing.
 *   - Sentences of arbitrary length don't blow up the URL.
 */

const ENTRIES_KEY = "get:notebook:v1";
const NOTES_KEY = "get:notebook-notes:v1";

export type NotebookKind = "phrase" | "sentence";
export type NotebookSource = "manual" | "ai";

/**
 * The AI payload returned by /api/ai/phrase and cached on the entry.
 * Kept intentionally loose (all optional except the core two) so a future
 * prompt tweak that adds/removes fields doesn't invalidate stored data.
 */
export interface PhraseAIResult {
  /** POS-ish tag: "verb phrase" | "prep phrase" | "idiom" | ... */
  posHint?: string;
  /** Chinese gloss, 1-3 short comma-separated phrases. */
  chn: string;
  /** English definition, one sentence. */
  def: string;
  /** 3-5 example sentences with translation. */
  examples: Array<{ en: string; cn: string }>;
  /** Common collocations / typical patterns. */
  collocations?: string[];
  /** Near-synonymous phrases for reference. */
  synonyms?: string[];
  /** Free-form usage notes / register hints. */
  notes?: string;
  provider: "deepseek" | "mock";
  /** When provider="mock": human-readable reason (e.g. "zhipu 429: rate limit").
   *  Absent on successful upstream calls and on legacy cached entries. */
  mockReason?: string;
  /** ISO timestamp of when the payload was generated. */
  generatedAt: string;
}

export interface NotebookEntry {
  id: string;
  kind: NotebookKind;
  source: NotebookSource;
  /** Original text (phrase or sentence). Stored verbatim for display. */
  text: string;
  /** Only present when source === "ai". Cached, never re-fetched. */
  ai?: PhraseAIResult;
  createdAt: string;
  updatedAt: string;
}

/** One free-form note attached to a notebook entry. Same shape as WordNote. */
export interface NotebookNote {
  id: string;
  entryId: string;
  body: string;
  /** Optional image as a data URL. */
  image?: string;
  createdAt: string;
  updatedAt: string;
}

type EntryStore = Record<string, NotebookEntry>;
type NotesStore = Record<string, NotebookNote[]>;

// ---------------------------------------------------------------------------
// low-level IO
// ---------------------------------------------------------------------------

export function readEntries(): EntryStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(ENTRIES_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as EntryStore;
  } catch {
    return {};
  }
}

export function writeEntries(store: EntryStore): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ENTRIES_KEY, JSON.stringify(store));
  window.dispatchEvent(new CustomEvent("get:notebook-change"));
}

export function readNotesStore(): NotesStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(NOTES_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as NotesStore;
  } catch {
    return {};
  }
}

export function writeNotesStore(store: NotesStore): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(NOTES_KEY, JSON.stringify(store));
  window.dispatchEvent(new CustomEvent("get:notebook-notes-change"));
}

function makeUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `nb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// id helpers
// ---------------------------------------------------------------------------

/**
 * Turn a phrase into a URL-safe, storage-safe slug.
 *   "Take Advantage Of  " → "take-advantage-of"
 * Non-ASCII characters (e.g. accented letters) get folded to ASCII where
 * possible; anything else is dropped. Multiple whitespace / punctuation
 * runs collapse to single hyphens.
 */
export function phraseSlug(text: string): string {
  const lowered = text.trim().toLowerCase();
  // Normalise to strip diacritics: "café" → "cafe".
  const stripped = lowered.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  return stripped
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80); // keep URLs sane for very long "phrases"
}

// ---------------------------------------------------------------------------
// entry CRUD
// ---------------------------------------------------------------------------

/** All entries, newest first. Optionally filter by kind. */
export function listEntries(kind?: NotebookKind): NotebookEntry[] {
  const all = Object.values(readEntries());
  const filtered = kind ? all.filter((e) => e.kind === kind) : all;
  return filtered.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function getEntry(id: string): NotebookEntry | null {
  return readEntries()[id] ?? null;
}

/** Look up a phrase entry by slug (id === slug for phrases). */
export function getPhraseBySlug(slug: string): NotebookEntry | null {
  const entry = readEntries()[slug];
  return entry && entry.kind === "phrase" ? entry : null;
}

/**
 * Create-or-update a phrase entry. Idempotent on slug so that hitting
 * `/notebook/phrase/take-advantage-of` twice doesn't duplicate the row.
 * If `ai` is provided AND the entry has no cached AI payload yet, we save
 * it. Once cached, subsequent calls with a fresh `ai` payload will NOT
 * overwrite it — spec locked "第一次AI生成即为最终版本" until the user
 * explicitly regenerates via a future button.
 */
export function upsertPhrase(input: {
  text: string;
  source: NotebookSource;
  ai?: PhraseAIResult;
}): NotebookEntry {
  const slug = phraseSlug(input.text);
  if (!slug) throw new Error("phrase text is empty after slugification");
  const store = readEntries();
  const now = new Date().toISOString();
  const existing = store[slug];
  const next: NotebookEntry = existing
    ? {
        ...existing,
        // Update the display text to the newest capitalisation the user
        // typed, but keep the original createdAt / source.
        text: input.text.trim(),
        // Preserve cached AI unless the entry never had one.
        ai: existing.ai ?? input.ai,
        updatedAt: now,
      }
    : {
        id: slug,
        kind: "phrase",
        source: input.source,
        text: input.text.trim(),
        ai: input.ai,
        createdAt: now,
        updatedAt: now,
      };
  store[slug] = next;
  writeEntries(store);
  return next;
}

/** Create a manual sentence entry. Sentences never have AI payloads. */
export function addSentence(text: string): NotebookEntry {
  const store = readEntries();
  const id = makeUuid();
  const now = new Date().toISOString();
  const entry: NotebookEntry = {
    id,
    kind: "sentence",
    source: "manual",
    text: text.trim(),
    createdAt: now,
    updatedAt: now,
  };
  store[id] = entry;
  writeEntries(store);
  return entry;
}

/** Overwrite the raw text on an existing entry (both phrase & sentence). */
export function updateEntryText(id: string, text: string): NotebookEntry | null {
  const store = readEntries();
  const existing = store[id];
  if (!existing) return null;
  const next: NotebookEntry = {
    ...existing,
    text: text.trim(),
    updatedAt: new Date().toISOString(),
  };
  store[id] = next;
  writeEntries(store);
  return next;
}

/** Remove an entry AND all its notes. */
export function deleteEntry(id: string): boolean {
  const store = readEntries();
  if (!store[id]) return false;
  delete store[id];
  writeEntries(store);
  const notes = readNotesStore();
  if (notes[id]) {
    delete notes[id];
    writeNotesStore(notes);
  }
  return true;
}

// ---------------------------------------------------------------------------
// notes CRUD
// ---------------------------------------------------------------------------

/** Notes for one entry, newest first. */
export function listNotes(entryId: string): NotebookNote[] {
  const notes = readNotesStore()[entryId] ?? [];
  return [...notes].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function addNote(
  entryId: string,
  body: string,
  image?: string,
): NotebookNote {
  const store = readNotesStore();
  const list = store[entryId] ?? [];
  const now = new Date().toISOString();
  const note: NotebookNote = {
    id: makeUuid(),
    entryId,
    body,
    image,
    createdAt: now,
    updatedAt: now,
  };
  store[entryId] = [note, ...list];
  writeNotesStore(store);
  // Bump the entry's updatedAt so it sorts to the top of the list page.
  const entries = readEntries();
  if (entries[entryId]) {
    entries[entryId] = { ...entries[entryId], updatedAt: now };
    writeEntries(entries);
  }
  return note;
}

export function updateNote(
  entryId: string,
  id: string,
  patch: { body?: string; image?: string | null },
): NotebookNote | null {
  const store = readNotesStore();
  const list = store[entryId];
  if (!list) return null;
  const idx = list.findIndex((n) => n.id === id);
  if (idx < 0) return null;
  const prev = list[idx];
  const next: NotebookNote = {
    ...prev,
    body: patch.body ?? prev.body,
    image: patch.image === null ? undefined : patch.image ?? prev.image,
    updatedAt: new Date().toISOString(),
  };
  list[idx] = next;
  writeNotesStore(store);
  return next;
}

export function deleteNote(entryId: string, id: string): boolean {
  const store = readNotesStore();
  const list = store[entryId];
  if (!list) return false;
  const next = list.filter((n) => n.id !== id);
  if (next.length === list.length) return false;
  store[entryId] = next;
  writeNotesStore(store);
  return true;
}

// ---------------------------------------------------------------------------
// heuristics
// ---------------------------------------------------------------------------

/**
 * Decide whether a raw search string should be treated as a phrase (routed
 * to the notebook AI flow) or a single-word dictionary lookup.
 *
 * Rules — deliberately conservative so single hyphenated words like
 * "e-mail" still hit the dictionary:
 *   - Contains internal whitespace → phrase.
 *   - Otherwise → single word.
 */
export function looksLikePhrase(input: string): boolean {
  return /\s/.test(input.trim());
}
