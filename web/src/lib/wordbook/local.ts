/**
 * Local-first query / wordbook tracking.
 *
 * V1 strategy: every successful lookup increments a per-lemma counter held in
 * localStorage. On Day 5 this same shape is mirrored to Supabase so multiple
 * devices converge. Keeping the same in-memory shape means the UI doesn't
 * have to change when we add the cloud half.
 *
 * Why not jump straight to Supabase here? — Day 2 wires the search and detail
 * pages BEFORE we open up auth, and we want a "查过 → 进新朋友本" loop that
 * works for the unauthenticated dev session too.
 */

const STORAGE_KEY = "get:wordbook:v1";
const NOTES_KEY = "get:notes:v1";

export type WordbookStatus = "new" | "old";

export interface WordbookEntry {
  lemma: string;
  status: WordbookStatus;
  /** Total successful lookups (also the input to "按查询次数排序"). */
  queryCount: number;
  /** Ebbinghaus level 0..7. 7 == graduated to "old friend". */
  level: number;
  /** ISO timestamp of first lookup. */
  firstSeenAt: string;
  /** ISO timestamp of most recent lookup or review. */
  lastSeenAt: string;
  /** ISO timestamp of when the entry next becomes due for review.
   *  Null = graduated; missing on legacy entries (treated as immediately due). */
  nextReviewAt?: string | null;
  /** Snapshot of the first sense's part-of-speech, captured at first lookup.
   *  Lets the wordbook page filter by pos without re-fetching dict shards. */
  pos?: string;
}

/**
 * One note attached to one lemma.
 * `image` is a data URL (base64). We store images inline so the local-only
 * dev experience stays self-contained; the cloud sync layer (Day 3b) will
 * upload base64 → Supabase Storage and replace this with a stable path.
 */
export interface WordNote {
  id: string;
  lemma: string;
  body: string;
  /** Optional image as a data URL ("data:image/png;base64,…"). */
  image?: string;
  createdAt: string;
  updatedAt: string;
}

type Store = Record<string, WordbookEntry>;
type NotesStore = Record<string, WordNote[]>; // lemma → notes

// ---------------------------------------------------------------------------
// shared low-level helpers
// ---------------------------------------------------------------------------

function readStore(): Store {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  // Notify same-tab listeners; the native `storage` event only fires across tabs.
  window.dispatchEvent(new CustomEvent("get:wordbook-change"));
}

function readNotes(): NotesStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(NOTES_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as NotesStore;
  } catch {
    return {};
  }
}

function writeNotes(notes: NotesStore): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  window.dispatchEvent(new CustomEvent("get:notes-change"));
}

// ---------------------------------------------------------------------------
// wordbook entry CRUD
// ---------------------------------------------------------------------------

/**
 * Record a successful lookup of `lemma`. Creates the entry if it didn't exist
 * (always as "new friend") and bumps the query counter otherwise.
 *
 * `pos` is an optional snapshot of the first sense's part of speech at the
 * time of the lookup; we stamp it on the entry once so the wordbook page can
 * filter by pos cheaply.
 */
export function recordLookup(lemma: string, pos?: string): WordbookEntry {
  const key = lemma.toLowerCase().trim();
  const store = readStore();
  const now = new Date().toISOString();
  const existing = store[key];
  const next: WordbookEntry = existing
    ? {
        ...existing,
        queryCount: existing.queryCount + 1,
        lastSeenAt: now,
        // Backfill pos on entries that pre-date this field.
        pos: existing.pos ?? pos,
      }
    : {
        lemma: key,
        status: "new",
        queryCount: 1,
        level: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        pos,
      };
  store[key] = next;
  writeStore(store);
  return next;
}

export function getEntry(lemma: string): WordbookEntry | null {
  return readStore()[lemma.toLowerCase().trim()] ?? null;
}

/** All wordbook entries — useful for the wordbook page on Day 3. */
export function listEntries(): WordbookEntry[] {
  return Object.values(readStore());
}

/** Map of lemma → true for words already in the wordbook. Used by the
 *  example-sentence highlighter ("已查过的词高亮"). */
export function getKnownLemmaSet(): Set<string> {
  return new Set(Object.keys(readStore()));
}

/**
 * Persist the outcome of one review attempt against `lemma`.
 *
 * - level moves +1 on pass / -1 on fail (clamped to [0, 7])
 * - status flips to "old" (毕业) when level reaches 7
 * - nextReviewAt is recomputed from the new level via the scheduler
 *
 * No-ops if the lemma isn't in the wordbook (shouldn't happen for review
 * targets, but defensive).
 */
export function recordReview(
  lemma: string,
  result: "pass" | "fail",
): WordbookEntry | null {
  const key = lemma.toLowerCase().trim();
  const store = readStore();
  const existing = store[key];
  if (!existing) return null;
  const nextLevel =
    result === "pass"
      ? Math.min(7, existing.level + 1)
      : Math.max(0, existing.level - 1);
  const now = new Date();
  // Schedule the next due time from the new level. Inline INTERVAL table
  // here to avoid an import cycle with scheduler.ts.
  const INTERVAL_DAYS = [0, 1, 2, 4, 7, 15, 30] as const;
  const next: WordbookEntry = {
    ...existing,
    level: nextLevel,
    status: nextLevel >= 7 ? "old" : existing.status,
    lastSeenAt: now.toISOString(),
    nextReviewAt:
      nextLevel >= 7
        ? null
        : (() => {
            const d = new Date(now);
            d.setDate(
              d.getDate() +
                INTERVAL_DAYS[Math.min(nextLevel, INTERVAL_DAYS.length - 1)],
            );
            return d.toISOString();
          })(),
  };
  store[key] = next;
  writeStore(store);
  return next;
}

/**
 * Toggle / set the lemma's status between "new friend" and "old friend".
 * Has no effect (returns null) if the lemma isn't in the wordbook yet —
 * status only makes sense after a first lookup.
 *
 * Side effect: when a user manually graduates a word to "old", we also bump
 * `level` to 7 so the Ebbinghaus scheduler stops surfacing it. Coming back
 * to "new" resets level to whatever it was (we keep the previous progress
 * implicitly by only writing 7 on graduation, never overwriting on demote).
 */
export function setStatus(lemma: string, status: WordbookStatus): WordbookEntry | null {
  const key = lemma.toLowerCase().trim();
  const store = readStore();
  const existing = store[key];
  if (!existing) return null;
  const next: WordbookEntry = {
    ...existing,
    status,
    level: status === "old" ? 7 : Math.min(existing.level, 6),
    lastSeenAt: new Date().toISOString(),
  };
  store[key] = next;
  writeStore(store);
  return next;
}

// ---------------------------------------------------------------------------
// notes CRUD
// ---------------------------------------------------------------------------

export function listNotes(lemma: string): WordNote[] {
  const key = lemma.toLowerCase().trim();
  const notes = readNotes()[key] ?? [];
  // newest first — that's what the user wrote most recently
  return [...notes].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function addNote(
  lemma: string,
  body: string,
  image?: string,
): WordNote {
  const key = lemma.toLowerCase().trim();
  const all = readNotes();
  const list = all[key] ?? [];
  const now = new Date().toISOString();
  const note: WordNote = {
    // crypto.randomUUID exists in all evergreen browsers; fall back to a
    // timestamp-based id if we're somehow on an ancient one.
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `n_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    lemma: key,
    body,
    image,
    createdAt: now,
    updatedAt: now,
  };
  all[key] = [note, ...list];
  writeNotes(all);
  return note;
}

export function updateNote(
  lemma: string,
  id: string,
  patch: { body?: string; image?: string | null },
): WordNote | null {
  const key = lemma.toLowerCase().trim();
  const all = readNotes();
  const list = all[key];
  if (!list) return null;
  const idx = list.findIndex((n) => n.id === id);
  if (idx < 0) return null;
  const prev = list[idx];
  const next: WordNote = {
    ...prev,
    body: patch.body ?? prev.body,
    image: patch.image === null ? undefined : patch.image ?? prev.image,
    updatedAt: new Date().toISOString(),
  };
  list[idx] = next;
  writeNotes(all);
  return next;
}

export function deleteNote(lemma: string, id: string): boolean {
  const key = lemma.toLowerCase().trim();
  const all = readNotes();
  const list = all[key];
  if (!list) return false;
  const next = list.filter((n) => n.id !== id);
  if (next.length === list.length) return false;
  all[key] = next;
  writeNotes(all);
  return true;
}
