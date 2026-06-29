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

/**
 * Wordbook membership states:
 *   - "new"      → 新朋友 (default after first lookup)
 *   - "old"      → 老朋友 (graduated, mastered)
 *   - "archived" → 不收藏 (looked up but explicitly excluded from both books)
 *
 * `archived` words still keep their query history (for the "已查过的词" highlight
 * and per-lemma stats), they just don't show up in either wordbook list.
 */
export type WordbookStatus = "new" | "old" | "archived";

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
  /** ISO timestamp of the most recent SEARCH-BAR lookup specifically.
   *  Distinct from lastSeenAt because clicking a word from the wordbook
   *  list (which mounts the detail page too) must NOT count as a fresh
   *  query — only entries originated from the top search box do. */
  lastQueriedAt?: string;
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
 * Record a lookup of `lemma`.
 *
 * - Creates the entry if it didn't exist. Default status is "new" (新朋友)
 *   for fresh search-bar lookups, but `opts.skipCount` (used when the user
 *   navigated in from inside the wordbook list) leaves the entry untouched
 *   if it already existed and avoids creating one if it didn't — viewing
 *   isn't "querying".
 * - When NOT skipping, bumps `queryCount`, refreshes `lastSeenAt` AND
 *   `lastQueriedAt`. Both timestamps are needed: lastSeenAt also moves on
 *   reviews, but the wordbook page wants the latest *query* date specifically.
 *
 * `pos` is an optional snapshot of the first sense's part of speech at the
 * time of the lookup; we stamp it on the entry once so the wordbook page can
 * filter by pos cheaply.
 */
export function recordLookup(
  lemma: string,
  pos?: string,
  opts?: { skipCount?: boolean },
): WordbookEntry | null {
  const key = lemma.toLowerCase().trim();
  const store = readStore();
  const now = new Date().toISOString();
  const existing = store[key];

  // skipCount == true means "the user opened the detail page from inside the
  // wordbook, not from the search bar". We must NOT create or count.
  if (opts?.skipCount) {
    return existing ?? null;
  }

  const next: WordbookEntry = existing
    ? {
        ...existing,
        queryCount: existing.queryCount + 1,
        lastSeenAt: now,
        lastQueriedAt: now,
        // pos resolution: an explicit pos argument always wins (the caller
        // KNOWS the right tag — e.g. the user just picked it from the chip
        // picker, or we just resolved it from the dictionary's first sense).
        // Only fall back to the stored pos when no new tag was supplied.
        // Using truthiness (not ??) so empty-string pos legacy rows get
        // overwritten rather than sticking around.
        pos: pos || existing.pos,
      }
    : {
        lemma: key,
        status: "new",
        queryCount: 1,
        level: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        lastQueriedAt: now,
        pos,
      };
  store[key] = next;
  writeStore(store);
  return next;
}

export function getEntry(lemma: string): WordbookEntry | null {
  return readStore()[lemma.toLowerCase().trim()] ?? null;
}

/** All wordbook entries — useful for the wordbook page on Day 3.
 *  By default omits `archived` so the new/old friend lists stay clean;
 *  pass `{ includeArchived: true }` for the full set. */
export function listEntries(opts?: { includeArchived?: boolean }): WordbookEntry[] {
  const all = Object.values(readStore());
  if (opts?.includeArchived) return all;
  return all.filter((e) => e.status !== "archived");
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
  // Archiving freezes the Ebbinghaus level — we don't want a 不收藏 word to
  // show up in review queues, but if the user later flips it back to "new"
  // we keep their progress.
  const nextLevel =
    status === "old"
      ? 7
      : status === "archived"
        ? existing.level
        : Math.min(existing.level, 6);
  const next: WordbookEntry = {
    ...existing,
    status,
    level: nextLevel,
    lastSeenAt: new Date().toISOString(),
  };
  store[key] = next;
  writeStore(store);
  return next;
}

/**
 * Update the snapshot pos on an existing entry. No-op (returns null) if
 * the lemma isn't in the wordbook yet — pos is only meaningful relative
 * to a recorded lookup. Used by the not-found flow where the user picks
 * the part of speech themselves (since there's no dictionary sense to
 * read it from), and may amend it later.
 */
export function setPos(lemma: string, pos: string): WordbookEntry | null {
  const key = lemma.toLowerCase().trim();
  const store = readStore();
  const existing = store[key];
  if (!existing) return null;
  const next: WordbookEntry = { ...existing, pos };
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
