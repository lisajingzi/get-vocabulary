/**
 * Cross-device review session records.
 *
 * A "session record" represents one in-progress review pass over a
 * user-chosen slice of the wordbook (or over the current wrong-book set).
 * Unlike the transient `sessionStorage` snapshot used by ReviewView to
 * survive a detail-page round-trip within the SAME tab, these records:
 *
 *   1. live in localStorage — survive tab close / browser restart;
 *   2. are synced to the cloud via the `reviewSessions` shard — a user
 *      who starts a pass on phone can resume it on desktop;
 *   3. carry the ORIGINAL filter selection so the UI can display "you
 *      were reviewing 雅思 · 5A · 听说写, 12/40 left".
 *
 * Merge semantics: last-write-wins by (updatedAt, deletedAt) per record id.
 * Tombstones (`deletedAt` set) prevent a completed record on device A
 * from being resurrected by device B's stale copy.  Tombstones older
 * than TOMBSTONE_TTL_MS are physically pruned on next write.
 */

const STORAGE_KEY = "get:review-sessions:v1";
const CHANGE_EVENT = "get:review-sessions-change";

/** How long we keep a tombstone around before physically deleting it. */
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Mirror of the FilterState shape used by ReviewView's picker. Duplicated
 *  here (instead of imported from the component) to keep this module free
 *  of React / component-layer imports. */
export type IeltsFilter = "all" | "ielts" | "nonielts";
export type PurposeFilter = "all" | "active" | "passive";

export interface ReviewSessionFilter {
  ielts: IeltsFilter;
  purpose: PurposeFilter;
  groups: string[];
  reviewCounts: number[];
  errorCounts: number[];
}

export type ReviewSessionMode = "recognize" | "spell";

export interface ReviewSessionRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** null when this is a wrong-book pass (no user-picked filter). */
  filter: ReviewSessionFilter | null;
  mode: ReviewSessionMode;
  fromWrongBook: boolean;
  /** Snapshot of the queue at start — lemma[]. */
  queue: string[];
  cursor: number;
  /** Lemmas that have been graded (pass or fail) so far. Used to compute
   *  "remaining" even if the queue got trimmed at resume-time because a
   *  word was deleted / no longer eligible. */
  finishedLemmas: string[];
  /** Tombstone marker. Non-empty ISO string ⇒ record is deleted. */
  deletedAt?: string;
}

interface StoreShape {
  version: 1;
  records: Record<string, ReviewSessionRecord>;
}

const EMPTY_STORE: StoreShape = { version: 1, records: {} };

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  // Cheap fallback — collision risk is negligible for a per-user store.
  return `rs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Raw storage I/O
// ---------------------------------------------------------------------------
function readRaw(): StoreShape {
  if (typeof window === "undefined") return { ...EMPTY_STORE };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_STORE };
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.records &&
      typeof parsed.records === "object"
    ) {
      return { version: 1, records: parsed.records as Record<string, ReviewSessionRecord> };
    }
    return { ...EMPTY_STORE };
  } catch {
    return { ...EMPTY_STORE };
  }
}

function pruneTombstones(store: StoreShape): StoreShape {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  let mutated = false;
  const next: Record<string, ReviewSessionRecord> = {};
  for (const [id, rec] of Object.entries(store.records)) {
    if (rec.deletedAt) {
      const t = Date.parse(rec.deletedAt);
      if (Number.isFinite(t) && t < cutoff) {
        mutated = true;
        continue; // drop
      }
    }
    next[id] = rec;
  }
  return mutated ? { version: 1, records: next } : store;
}

function writeRaw(store: StoreShape): void {
  if (typeof window === "undefined") return;
  const pruned = pruneTombstones(store);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned));
  } catch (e) {
    console.error("[wordbook/review-sessions] writeRaw failed", e);
    throw e;
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Every non-tombstoned record, sorted by createdAt ASC (oldest first —
 *  the UI shows the earliest-started pass at the top so users work
 *  through them oldest → newest). */
export function listSessions(): ReviewSessionRecord[] {
  const store = readRaw();
  const out: ReviewSessionRecord[] = [];
  for (const rec of Object.values(store.records)) {
    if (rec.deletedAt) continue;
    out.push(rec);
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return out;
}

export function getSession(id: string): ReviewSessionRecord | null {
  const rec = readRaw().records[id];
  if (!rec || rec.deletedAt) return null;
  return rec;
}

/** First non-tombstoned wrong-book record, or null. There should only ever
 *  be one at a time (we resume it instead of creating a new one). */
export function findWrongBookSession(): ReviewSessionRecord | null {
  for (const rec of listSessions()) {
    if (rec.fromWrongBook) return rec;
  }
  return null;
}

/** Create a new record. Returns the created record (with its assigned id). */
export function createSession(input: {
  filter: ReviewSessionFilter | null;
  mode: ReviewSessionMode;
  fromWrongBook: boolean;
  queue: string[];
}): ReviewSessionRecord {
  const now = nowIso();
  const rec: ReviewSessionRecord = {
    id: newId(),
    createdAt: now,
    updatedAt: now,
    filter: input.filter,
    mode: input.mode,
    fromWrongBook: input.fromWrongBook,
    queue: [...input.queue],
    cursor: 0,
    finishedLemmas: [],
  };
  const store = readRaw();
  store.records[rec.id] = rec;
  writeRaw(store);
  return rec;
}

/** Update progress on an existing record. No-op if it doesn't exist or
 *  is tombstoned. */
export function updateSessionProgress(
  id: string,
  patch: { cursor?: number; finishedLemmas?: string[]; queue?: string[] },
): void {
  const store = readRaw();
  const rec = store.records[id];
  if (!rec || rec.deletedAt) return;
  const next: ReviewSessionRecord = {
    ...rec,
    ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}),
    ...(patch.finishedLemmas ? { finishedLemmas: patch.finishedLemmas } : {}),
    ...(patch.queue ? { queue: patch.queue } : {}),
    updatedAt: nowIso(),
  };
  store.records[id] = next;
  writeRaw(store);
}

/** Mark a record deleted (writes a tombstone rather than physically removing
 *  it, so the deletion propagates across devices and survives a stale push
 *  from a device that still has the record). */
export function removeSession(id: string): void {
  const store = readRaw();
  const rec = store.records[id];
  if (!rec) return;
  const now = nowIso();
  store.records[id] = {
    ...rec,
    deletedAt: now,
    updatedAt: now,
  };
  writeRaw(store);
}

// ---------------------------------------------------------------------------
// Cloud-sync helpers
// ---------------------------------------------------------------------------
export type ReviewSessionsStore = StoreShape;

export function readSessionsStore(): ReviewSessionsStore {
  return readRaw();
}

export function writeSessionsStore(store: ReviewSessionsStore): void {
  if (!store || typeof store !== "object") return;
  const clean: StoreShape = {
    version: 1,
    records:
      store.records && typeof store.records === "object" ? store.records : {},
  };
  writeRaw(clean);
}

/** Merge two stores. For each id we keep whichever side has the later
 *  effective timestamp (max(updatedAt, deletedAt)); tombstones win on
 *  ties because a deletion should not be resurrected. */
export function mergeSessionsStore(
  local: ReviewSessionsStore | null | undefined,
  remote: ReviewSessionsStore | null | undefined,
): ReviewSessionsStore {
  const l = local?.records ?? {};
  const r = remote?.records ?? {};
  const out: Record<string, ReviewSessionRecord> = { ...l };
  const effectiveTs = (rec: ReviewSessionRecord): string => {
    if (rec.deletedAt && rec.deletedAt > rec.updatedAt) return rec.deletedAt;
    return rec.updatedAt;
  };
  for (const [id, remoteRec] of Object.entries(r)) {
    const localRec = out[id];
    if (!localRec) {
      out[id] = remoteRec;
      continue;
    }
    const lt = effectiveTs(localRec);
    const rt = effectiveTs(remoteRec);
    if (rt > lt) {
      out[id] = remoteRec;
    } else if (rt === lt && remoteRec.deletedAt && !localRec.deletedAt) {
      // Tombstone breaks the tie.
      out[id] = remoteRec;
    }
  }
  return pruneTombstones({ version: 1, records: out });
}
