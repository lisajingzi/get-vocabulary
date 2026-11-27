/**
 * Cloud sync — COS backend, sharded.
 *
 * Design goals (learned the hard way):
 *   1. Never ship a single multi-MB request. Big responses time out on
 *      mobile networks and get killed by WeChat/Vercel edge quirks.
 *   2. Never blindly overwrite the cloud from a partially-hydrated client.
 *   3. Never let one sub-store's failure corrupt the others.
 *
 * Data model:
 *   - 8 independent shards, one per top-level store:
 *       wordbook / wordNotes / notebook / notebookNotes / punches /
 *       preferences / reviewLog / dailySnapshot
 *   - Each shard is its own object in COS at /sync/<syncId>/<shard>.json
 *   - Pull downloads all 8 in parallel (Promise.allSettled); a failure on
 *     any one shard does NOT block the others.
 *   - Push only sends dirty shards. Every local write flags its shard
 *     dirty; the debounced pusher flushes them individually.
 *
 * Backwards compatibility:
 *   - `getSyncId / setSyncId / isSyncIdLocked / pull / push / pushManual /
 *     schedulePush / flushPush / isPullGateOpen` all keep their old
 *     signatures so no UI changes are required.
 *   - On first successful pull, if every shard is empty on cloud we
 *     transparently try the legacy monolithic snapshot and split it
 *     across the new shards. The legacy blob is left in place as a
 *     read-only fallback.
 */

import {
  readStore as readWordbookRaw,
  writeStore as writeWordbookRaw,
  readNotes as readWordNotesRaw,
  writeNotes as writeWordNotesRaw,
  type WordbookEntry,
  type WordNote,
} from "@/lib/wordbook/local";
import {
  readEntries as readNotebookRaw,
  writeEntries as writeNotebookRaw,
  readNotesStore as readNotebookNotesRaw,
  writeNotesStore as writeNotebookNotesRaw,
  type NotebookEntry,
  type NotebookNote,
} from "@/lib/notebook/local";
import {
  readStore as readStringNotesRaw,
  writeStore as writeStringNotesRaw,
  mergeStringNotes,
  type StringNote,
} from "@/lib/wordbook/string-notes";
import { listPunches, writePunchesRaw } from "@/lib/wordbook/punches";
import {
  readReviewLog,
  writeReviewLog,
  mergeReviewLog,
  type ReviewLog,
} from "@/lib/wordbook/review-log";
import {
  getPreferences,
  replacePreferences,
  type Preferences,
} from "@/lib/wordbook/preferences";
import {
  invalidateSnapshotIfEmpty,
  readSnapshotPayload,
  applyRemoteSnapshot,
  type SnapshotPayload,
} from "@/lib/wordbook/daily-snapshot";
import {
  readSessionsStore,
  writeSessionsStore,
  mergeSessionsStore,
  type ReviewSessionsStore,
} from "@/lib/wordbook/review-sessions";
import {
  readGroupsStore,
  writeGroupsStore,
  mergeGroupsStore,
  type GroupsStore,
} from "@/lib/wordbook/groups";

// ---------------------------------------------------------------------------
// Sync ID (unchanged from previous impl)
// ---------------------------------------------------------------------------
const SYNC_ID_KEY = "get:syncId:v1";
const FIXED_SYNC_ID = process.env.NEXT_PUBLIC_SYNC_ID ?? "";

export function getSyncId(): string {
  if (FIXED_SYNC_ID) return FIXED_SYNC_ID;
  if (typeof window === "undefined") return "";
  const existing = window.localStorage.getItem(SYNC_ID_KEY);
  if (existing) return existing;
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(
          /[xy]/g,
          (c) => {
            const r = (Math.random() * 16) | 0;
            return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
          },
        );
  try {
    window.localStorage.setItem(SYNC_ID_KEY, id);
  } catch {
    /* quota exhausted — nothing we can do here, caller will get a fresh id every call */
  }
  return id;
}

export function setSyncId(id: string): void {
  if (FIXED_SYNC_ID) return;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SYNC_ID_KEY, id);
  } catch {
    /* ignore */
  }
}

export function isSyncIdLocked(): boolean {
  return Boolean(FIXED_SYNC_ID);
}

// ---------------------------------------------------------------------------
// Safety gate — has this session ever pulled successfully?
// ---------------------------------------------------------------------------
// Kept from the previous implementation. Reasoning: on cold start, various
// migration helpers can dispatch change events that schedule pushes before
// pull() has finished. Gating auto-push until at least one shard has
// completed a pull prevents blanking the cloud with an empty local state.
let hasPulledOnce = false;
export function isPullGateOpen(): boolean {
  return hasPulledOnce;
}

// Network timeout per shard fetch. Small enough that a stuck request fails
// fast, big enough for slow mobile networks to complete a legit request.
const SYNC_FETCH_TIMEOUT_MS = 20_000;
function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = SYNC_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  // Pass a real Error as the abort reason so downstream catches surface a
  // meaningful message instead of the opaque "signal is aborted without
  // reason" the browser invents when reason is undefined.
  const timer = setTimeout(
    () => controller.abort(new Error(`sync fetch timeout after ${timeoutMs}ms`)),
    timeoutMs,
  );
  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

// Sleep helper used by putShardRaw's retry loop.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Is this error worth retrying? Network blips, timeouts and 5xx yes;
// 4xx (bad request / auth) no — those won't get better by hitting again.
function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/HTTP 4\d\d/.test(msg)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Shard definitions
// ---------------------------------------------------------------------------
export type ShardName =
  | "wordbook"
  | "wordNotes"
  | "notebook"
  | "notebookNotes"
  | "punches"
  | "preferences"
  | "reviewLog"
  | "dailySnapshot"
  | "stringNotes"
  | "reviewSessions"
  | "groups";

const ALL_SHARDS: ShardName[] = [
  "wordbook",
  "wordNotes",
  "notebook",
  "notebookNotes",
  "punches",
  "preferences",
  "reviewLog",
  "dailySnapshot",
  "stringNotes",
  "reviewSessions",
  "groups",
];

// Every shard payload carries a savedAt so we can compare envelopes at the
// shard level (used by future merge strategies; per-entry timestamps in
// wordbook/notes are still the source of truth for entry-level merges).
interface ShardEnvelope<T> {
  version: 1;
  savedAt: string;
  data: T;
}

function envelope<T>(data: T): ShardEnvelope<T> {
  return { version: 1, savedAt: new Date().toISOString(), data };
}

// Extract the payload from an envelope. Also accepts a "bare" payload
// (no envelope) for forward-compat and for the legacy migration path.
function unwrap<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "object" && raw !== null && "data" in raw) {
    return (raw as ShardEnvelope<T>).data;
  }
  return raw as T;
}

// ---------------------------------------------------------------------------
// Dirty tracking
// ---------------------------------------------------------------------------
// Every local write flags its shard dirty via markDirty(shard). The
// debounced pusher flushes only dirty shards. Cleared per-shard on
// successful upload.
const dirty = new Set<ShardName>();

export function markDirty(shard: ShardName): void {
  dirty.add(shard);
}

// Which shard does a given change event belong to? Referenced from
// SyncProvider so the two files agree.
export const EVENT_TO_SHARD: Record<string, ShardName> = {
  "get:wordbook-change": "wordbook",
  "get:notes-change": "wordNotes",
  "get:notebook-change": "notebook",
  "get:notebook-notes-change": "notebookNotes",
  "get:punch-change": "punches",
  "get:preferences-change": "preferences",
  "get:review-log-change": "reviewLog",
  "get:daily-snapshot-local-write": "dailySnapshot",
  "get:string-notes-change": "stringNotes",
  "get:review-sessions-change": "reviewSessions",
  "get:groups-change": "groups",
};

// ---------------------------------------------------------------------------
// Legacy snapshot shape (kept for one-time migration)
// ---------------------------------------------------------------------------
export interface SyncSnapshot {
  version: 1;
  savedAt: string;
  wordbook: Record<string, WordbookEntry>;
  wordNotes: Record<string, WordNote[]>;
  notebook: Record<string, NotebookEntry>;
  notebookNotes: Record<string, NotebookNote[]>;
  punches: string[];
  preferences?: Preferences;
  dailySnapshot?: SnapshotPayload;
  reviewLog?: ReviewLog;
}

// ---------------------------------------------------------------------------
// Merge helpers (unchanged — last-write-wins per entry by timestamp)
// ---------------------------------------------------------------------------
function effectiveQueryCount(e: WordbookEntry): number {
  if (e.queryCount === 1 && !e.lastQueriedAt) return 0;
  return e.queryCount;
}

function mergeWordbook(
  local: Record<string, WordbookEntry>,
  remote: Record<string, WordbookEntry>,
): Record<string, WordbookEntry> {
  const merged = { ...local };
  for (const [lemma, remoteEntry] of Object.entries(remote)) {
    const localEntry = merged[lemma];
    if (!localEntry || remoteEntry.lastSeenAt > localEntry.lastSeenAt) {
      merged[lemma] = {
        ...remoteEntry,
        queryCount: effectiveQueryCount(remoteEntry),
      };
    } else {
      merged[lemma] = {
        ...localEntry,
        queryCount: Math.max(
          effectiveQueryCount(localEntry),
          effectiveQueryCount(remoteEntry),
        ),
      };
    }
  }
  return merged;
}

function mergeNoteArrays<T extends { id: string; updatedAt: string }>(
  local: T[],
  remote: T[],
): T[] {
  const map = new Map<string, T>();
  for (const n of local) map.set(n.id, n);
  for (const n of remote) {
    const l = map.get(n.id);
    if (!l || n.updatedAt > l.updatedAt) map.set(n.id, n);
  }
  return Array.from(map.values());
}

function mergeNoteMaps<T extends { id: string; updatedAt: string }>(
  local: Record<string, T[]>,
  remote: Record<string, T[]>,
): Record<string, T[]> {
  const merged: Record<string, T[]> = { ...local };
  for (const [key, remoteNotes] of Object.entries(remote)) {
    merged[key] = mergeNoteArrays(merged[key] ?? [], remoteNotes);
  }
  return merged;
}

function mergeNotebook(
  local: Record<string, NotebookEntry>,
  remote: Record<string, NotebookEntry>,
): Record<string, NotebookEntry> {
  const merged = { ...local };
  for (const [id, remoteEntry] of Object.entries(remote)) {
    const localEntry = merged[id];
    if (!localEntry || remoteEntry.updatedAt > localEntry.updatedAt) {
      merged[id] = remoteEntry;
    }
  }
  return merged;
}

function mergePunches(local: string[], remote: string[]): string[] {
  return Array.from(new Set([...local, ...remote])).sort();
}

// ---------------------------------------------------------------------------
// Shard ETag cache — the client half of the conditional-request scheme
// ---------------------------------------------------------------------------
//
// /api/cos/sync forwards If-None-Match to COS and relays COS's 304. For
// that to ever trigger, we must remember the ETag we last saw per shard
// and send it back. We can't rely on the browser's own HTTP cache here
// because the fetches use `cache: "no-store"` (needed so a stale body is
// never served silently), so the ETag is tracked explicitly.
//
// Persisted in localStorage so the saving also applies to the very first
// pull after a page reload — which is by far the most common pull.
const ETAG_STORE_KEY = "get:syncEtags:v1";

type EtagMap = Partial<Record<string, string>>;

let etagCache: EtagMap | null = null;

function readEtags(): EtagMap {
  if (etagCache) return etagCache;
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(ETAG_STORE_KEY);
    etagCache = raw ? (JSON.parse(raw) as EtagMap) : {};
  } catch {
    etagCache = {};
  }
  return etagCache;
}

function getEtag(shard: string): string | undefined {
  return readEtags()[shard];
}

function setEtag(shard: string, etag: string | null): void {
  const map = readEtags();
  if (etag) map[shard] = etag;
  else delete map[shard];
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ETAG_STORE_KEY, JSON.stringify(map));
  } catch {
    /* quota — degrades to unconditional requests, still correct */
  }
}

/**
 * Drop a shard's cached ETag. Called after a successful PUT: our own
 * upload changed the object, so the stored validator is stale and the
 * next pull must fetch the new body in full.
 */
function invalidateEtag(shard: ShardName): void {
  setEtag(shard, null);
}

/**
 * Sentinel returned by fetchShardRaw when the server answered 304.
 * Distinct from `null` (which legitimately means "no data on cloud") so
 * the caller can skip merging entirely instead of treating it as empty.
 */
const NOT_MODIFIED = Symbol("not-modified");

// ---------------------------------------------------------------------------
// Low-level shard I/O
// ---------------------------------------------------------------------------
async function fetchShardRaw(
  syncId: string,
  shard: ShardName | "__legacy__",
): Promise<unknown | typeof NOT_MODIFIED> {
  const headers: Record<string, string> = {};
  const known = getEtag(shard);
  if (known) headers["If-None-Match"] = known;

  const res = await fetchWithTimeout(
    `/api/cos/sync?syncId=${encodeURIComponent(syncId)}&shard=${shard}`,
    { cache: "no-store", headers },
  );

  // Nothing changed since last time — zero bytes transferred.
  if (res.status === 304) return NOT_MODIFIED;

  if (!res.ok) {
    let err: { error?: string } = {};
    try {
      err = await res.json();
    } catch {
      /* body wasn't JSON */
    }
    throw new Error(err?.error ?? `HTTP ${res.status}`);
  }

  // Remember the new validator for next time.
  setEtag(shard, res.headers.get("etag"));
  return res.json();
}

// ---------------------------------------------------------------------------
// Retry budget — the circuit breaker that stops runaway upload loops
// ---------------------------------------------------------------------------
//
// The previous design had no upper bound: putShardRaw retried 3x
// internally, push() rescheduled itself 15s after any failure, and the
// pull-gate path rescheduled every 2s. A shard that could never upload
// (too large, or a persistently failing network) would therefore re-send
// its full payload forever. With multi-MB shards that is precisely how
// 16 GB of origin transfer got burned in two days.
//
// Now every push consumes from a session-wide budget. Once exhausted,
// auto-push stops permanently for this page session and the UI is told
// to surface an error. A manual push from Settings resets the budget,
// so the user always has an explicit escape hatch.
const MAX_PUSH_FAILURES = 6;
let pushFailureBudget = MAX_PUSH_FAILURES;

/** True once we've given up on auto-pushing for this session. */
export function isPushCircuitOpen(): boolean {
  return pushFailureBudget <= 0;
}

/** Restore the budget. Called by the manual "upload all" path. */
export function resetPushBudget(): void {
  pushFailureBudget = MAX_PUSH_FAILURES;
}

async function putShardRaw(
  syncId: string,
  shard: ShardName,
  payload: unknown,
): Promise<void> {
  // Serialize once outside the retry loop — if JSON.stringify throws
  // (circular ref etc.) retrying won't help.
  const body = JSON.stringify(payload);
  // Two attempts with a short backoff. Trimmed from the original three
  // (0/2s/6s): each attempt re-uploads the entire shard, so extra tries
  // are directly proportional to wasted bandwidth. Transient blips are
  // better handled by the outer scheduled retry than by hammering here.
  const delays = [0, 3_000];
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);
    try {
      const res = await fetchWithTimeout(
        `/api/cos/sync?syncId=${encodeURIComponent(syncId)}&shard=${shard}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body,
        },
      );
      if (!res.ok) {
        let err: { error?: string } = {};
        try {
          err = await res.json();
        } catch {
          /* ignore */
        }
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      // We just replaced the remote object, so any ETag we were holding
      // for it is stale. Clear it so the next pull fetches the new body
      // rather than getting a misleading 304.
      invalidateEtag(shard);
      return; // success
    } catch (e) {
      lastErr = e;
      if (!isTransientError(e)) break; // 4xx — no point retrying
      // else loop and try again
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(String(lastErr ?? "putShardRaw failed"));
}

// ---------------------------------------------------------------------------
// Per-shard readers / writers (bridge to local storage)
// ---------------------------------------------------------------------------
type ShardReader<T> = () => T;
type ShardWriter<T> = (data: T) => void;

interface ShardBinding<T> {
  read: ShardReader<T>;
  write: ShardWriter<T>;
  merge: (local: T, remote: T) => T;
}

const SHARD_BINDINGS: { [K in ShardName]: ShardBinding<unknown> } = {
  wordbook: {
    read: () => readWordbookRaw() as unknown,
    write: (d) => writeWordbookRaw(d as Record<string, WordbookEntry>),
    merge: (l, r) =>
      mergeWordbook(
        l as Record<string, WordbookEntry>,
        r as Record<string, WordbookEntry>,
      ),
  },
  wordNotes: {
    read: () => readWordNotesRaw() as unknown,
    write: (d) => writeWordNotesRaw(d as Record<string, WordNote[]>),
    merge: (l, r) =>
      mergeNoteMaps(
        l as Record<string, WordNote[]>,
        r as Record<string, WordNote[]>,
      ),
  },
  notebook: {
    read: () => readNotebookRaw() as unknown,
    write: (d) => writeNotebookRaw(d as Record<string, NotebookEntry>),
    merge: (l, r) =>
      mergeNotebook(
        l as Record<string, NotebookEntry>,
        r as Record<string, NotebookEntry>,
      ),
  },
  notebookNotes: {
    read: () => readNotebookNotesRaw() as unknown,
    write: (d) => writeNotebookNotesRaw(d as Record<string, NotebookNote[]>),
    merge: (l, r) =>
      mergeNoteMaps(
        l as Record<string, NotebookNote[]>,
        r as Record<string, NotebookNote[]>,
      ),
  },
  punches: {
    read: () => listPunches() as unknown,
    write: (d) => writePunchesRaw(d as string[]),
    merge: (l, r) => mergePunches(l as string[], r as string[]),
  },
  preferences: {
    read: () => getPreferences() as unknown,
    // Preferences don't carry timestamps; last-write-wins by whole object.
    write: (d) => {
      if (d) replacePreferences(d as Preferences);
    },
    merge: (_l, r) => r, // remote wins (arrives via pull path)
  },
  reviewLog: {
    read: () => readReviewLog() as unknown,
    write: (d) => writeReviewLog(d as ReviewLog),
    merge: (l, r) => mergeReviewLog(l as ReviewLog, r as ReviewLog),
  },
  dailySnapshot: {
    read: () => readSnapshotPayload() as unknown,
    // Application handled specially in pull() — this write path is for
    // completeness / testing only.
    write: (d) => {
      if (d) applyRemoteSnapshot(d as SnapshotPayload);
    },
    merge: (_l, r) => r,
  },
  stringNotes: {
    read: () => readStringNotesRaw() as unknown,
    write: (d) => writeStringNotesRaw(d as Record<string, StringNote>),
    merge: (l, r) =>
      mergeStringNotes(
        l as Record<string, StringNote>,
        r as Record<string, StringNote>,
      ),
  },
  reviewSessions: {
    read: () => readSessionsStore() as unknown,
    write: (d) => writeSessionsStore(d as ReviewSessionsStore),
    merge: (l, r) =>
      mergeSessionsStore(
        l as ReviewSessionsStore,
        r as ReviewSessionsStore,
      ),
  },
  groups: {
    read: () => readGroupsStore() as unknown,
    write: (d) => writeGroupsStore(d as GroupsStore),
    merge: (l, r) => mergeGroupsStore(l as GroupsStore, r as GroupsStore),
  },
};

// ---------------------------------------------------------------------------
// Pull — download all shards in parallel, merge into local
// ---------------------------------------------------------------------------
/**
 * Result of pulling a single shard.
 *   ok       — shard downloaded and merged (may have been empty on cloud)
 *   error    — shard fetch or merge failed; other shards are unaffected
 *   skipped  — shard endpoint returned null (no data yet on cloud)
 */
interface ShardPullResult {
  shard: ShardName;
  ok: boolean;
  hadRemoteData: boolean;
  error?: string;
}

async function pullOneShard(
  syncId: string,
  shard: ShardName,
): Promise<ShardPullResult> {
  try {
    const raw = await fetchShardRaw(syncId, shard);

    // 304 — our local copy already reflects the cloud. No body was
    // transferred and there is nothing to merge. Report it as a success
    // with remote data present, so the "everything empty → try legacy
    // migration" branch doesn't misfire on an up-to-date device.
    if (raw === NOT_MODIFIED) {
      return { shard, ok: true, hadRemoteData: true };
    }

    const remote = unwrap<unknown>(raw);
    if (remote === null || remote === undefined) {
      return { shard, ok: true, hadRemoteData: false };
    }
    const binding = SHARD_BINDINGS[shard];
    const local = binding.read();
    let merged: unknown;
    try {
      merged = binding.merge(local, remote);
    } catch (e) {
      return {
        shard,
        ok: false,
        hadRemoteData: true,
        error: `merge failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    try {
      binding.write(merged);
    } catch (e) {
      return {
        shard,
        ok: false,
        hadRemoteData: true,
        error: `write failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    return { shard, ok: true, hadRemoteData: true };
  } catch (e) {
    return {
      shard,
      ok: false,
      hadRemoteData: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * One-time migration from the legacy monolithic snapshot to sharded storage.
 * Called only when every shard came back empty on the first pull and we
 * therefore suspect this is a device that has only ever seen the old
 * format. Splits the legacy blob into per-shard writes locally (no push
 * yet — regular dirty flags will handle uploading over time, or the
 * settings page's manual "upload all" will do it in one shot).
 */
async function migrateFromLegacyIfNeeded(syncId: string): Promise<boolean> {
  let raw: unknown;
  try {
    raw = await fetchShardRaw(syncId, "__legacy__");
  } catch (e) {
    // Legacy fetch failure is not fatal — device just has no cloud data.
    console.warn("[sync] legacy fetch failed", e);
    return false;
  }
  if (raw == null || raw === NOT_MODIFIED) return false;
  const legacy = raw as Partial<SyncSnapshot>;

  // Merge each field into local using the same per-shard merge helpers.
  try {
    if (legacy.wordbook) {
      writeWordbookRaw(mergeWordbook(readWordbookRaw(), legacy.wordbook));
    }
    if (legacy.wordNotes) {
      writeWordNotesRaw(mergeNoteMaps(readWordNotesRaw(), legacy.wordNotes));
    }
    if (legacy.notebook) {
      writeNotebookRaw(mergeNotebook(readNotebookRaw(), legacy.notebook));
    }
    if (legacy.notebookNotes) {
      writeNotebookNotesRaw(
        mergeNoteMaps(readNotebookNotesRaw(), legacy.notebookNotes),
      );
    }
    if (legacy.punches) {
      writePunchesRaw(mergePunches(listPunches(), legacy.punches));
    }
    if (legacy.preferences) replacePreferences(legacy.preferences);
    if (legacy.reviewLog) {
      writeReviewLog(mergeReviewLog(readReviewLog(), legacy.reviewLog));
    }
    // dailySnapshot handled by pull() below.
  } catch (e) {
    console.warn("[sync] legacy migration write failed", e);
    return false;
  }

  // Flag every shard dirty so the next auto-push (or manual "upload all")
  // uploads them into the new sharded layout.
  for (const s of ALL_SHARDS) markDirty(s);
  return true;
}

/**
 * Pull all shards from the cloud and merge into local. Returns
 * `{ merged, error? }` where `merged` is true if at least one shard
 * produced usable data, and `error` is set to a summary string if any
 * shard failed (other shards may still have succeeded).
 */
export async function pull(overrideSyncId?: string): Promise<{
  merged: boolean;
  error?: string;
}> {
  const syncId = overrideSyncId ?? getSyncId();
  if (!syncId) return { merged: false, error: "no syncId" };

  // Fetch all shards in parallel. allSettled so one shard's failure
  // doesn't abort the others.
  const results = await Promise.all(
    ALL_SHARDS.map((s) => pullOneShard(syncId, s)),
  );

  const failed = results.filter((r) => !r.ok);
  const anyRemoteData = results.some((r) => r.hadRemoteData);

  // If nothing came back from any shard, this might be a device that only
  // ever saw the legacy monolithic snapshot. Try that path.
  if (!anyRemoteData) {
    const migrated = await migrateFromLegacyIfNeeded(syncId);
    if (migrated) {
      hasPulledOnce = true;
      // Dispatch a change event so the UI re-renders from the freshly
      // populated stores. Guard against SSR.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("get:wordbook-change"));
      }
      return { merged: true };
    }
  }

  // Post-pull housekeeping (was in the old pull() too):
  invalidateSnapshotIfEmpty();

  // Daily snapshot cross-device merge — remote takes priority for today.
  // We do this after generic shard merge because daily snapshot has
  // special semantics (must match today's date).
  //
  // We already stored the raw remote payload via the dailySnapshot shard
  // write path above, but that path is unconditional. The rule we want:
  //   - If remote daily is today → adopt or union with local.
  //   - If remote daily is not today → don't touch local.
  // Since applyRemoteSnapshot happily accepts anything, we defensively
  // re-check the invariant here using the local state that resulted.
  const localDaily = readSnapshotPayload();
  const today = new Date();
  const localDay = `${today.getFullYear()}-${String(
    today.getMonth() + 1,
  ).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (localDaily && localDaily.date !== localDay) {
    // Stale daily from remote — drop it so today's logic re-freezes.
    invalidateSnapshotIfEmpty();
  }

  hasPulledOnce = true;

  // If any shards were flagged dirty while the initial pull was in flight
  // (very common — users start interacting with the page as soon as it
  // paints), those writes got skipped by push()'s hasPulledOnce gate. Now
  // that the gate is open, drain them on the next tick so we don't lose
  // data if the user then stops interacting.
  if (typeof window !== "undefined" && dirty.size > 0) {
    schedulePush(500);
  }

  if (failed.length > 0) {
    const summary = failed
      .map((r) => `${r.shard}: ${r.error ?? "unknown"}`)
      .join("; ");
    return {
      merged: anyRemoteData,
      error: `${failed.length} shard(s) failed — ${summary}`,
    };
  }
  return { merged: anyRemoteData };
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------
/**
 * Push all dirty shards (or a specified subset). Returns per-shard results
 * so callers can surface a partial-success in the UI if needed.
 */
async function pushShards(
  shards: ShardName[],
): Promise<{ ok: ShardName[]; failed: { shard: ShardName; error: string }[] }> {
  const syncId = getSyncId();
  const ok: ShardName[] = [];
  const failed: { shard: ShardName; error: string }[] = [];
  if (!syncId || shards.length === 0) return { ok, failed };

  await Promise.all(
    shards.map(async (shard) => {
      try {
        const binding = SHARD_BINDINGS[shard];
        const data = binding.read();
        // Skip null/undefined payloads (e.g. no daily snapshot yet).
        if (data == null) {
          ok.push(shard);
          dirty.delete(shard);
          return;
        }
        await putShardRaw(syncId, shard, envelope(data));
        dirty.delete(shard);
        ok.push(shard);
      } catch (e) {
        failed.push({
          shard,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }),
  );
  return { ok, failed };
}

/**
 * Automatic push. Called by the debounced scheduler on data changes.
 * Skips entirely if no initial pull has succeeded yet — otherwise a fresh
 * device could blast empty shards over the cloud copy.
 * Only pushes shards flagged dirty.
 */
export async function push(): Promise<void> {
  // Circuit breaker: too many consecutive failures this session means
  // something is systematically wrong (payload too big, COS misconfigured,
  // network down). Continuing to retry just burns bandwidth, which is the
  // exact failure mode that exhausted the hosting quota before.
  if (isPushCircuitOpen()) {
    return;
  }
  if (!hasPulledOnce) {
    // Initial pull hasn't completed yet. Re-queue so the dirty shards
    // aren't stranded, but count it against the budget so a pull that
    // never succeeds can't spin this forever.
    pushFailureBudget -= 1;
    console.warn(
      "[sync] auto-push deferred: initial pull hasn't completed yet; will retry in 2s",
    );
    schedulePush(2_000);
    return;
  }
  const syncId = getSyncId();
  if (!syncId) {
    pushFailureBudget -= 1;
    console.warn("[sync] auto-push deferred: no syncId yet; will retry in 5s");
    schedulePush(5_000);
    return;
  }
  const targets = Array.from(dirty);
  if (targets.length === 0) return;

  const { failed } = await pushShards(targets);
  if (failed.length > 0) {
    // Keep failed shards flagged dirty and schedule one more attempt,
    // but spend a unit of the retry budget first. When the budget runs
    // out we stop entirely and leave the error banner up — the user can
    // force a retry from Settings, which resets the budget.
    for (const f of failed) dirty.add(f.shard);
    pushFailureBudget -= 1;

    const exhausted = isPushCircuitOpen();
    console.warn(
      exhausted
        ? "[sync] auto-push giving up after repeated failures:"
        : "[sync] auto-push partial failure, will retry in 15s:",
      failed.map((f) => `${f.shard}=${f.error}`).join("; "),
    );
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("get:sync-error", {
          detail: {
            failed: failed.map((f) => ({ shard: f.shard, error: f.error })),
            at: new Date().toISOString(),
            exhausted,
          },
        }),
      );
    }
    if (!exhausted) schedulePush(15_000);
  } else {
    // A clean round restores the budget — intermittent blips shouldn't
    // accumulate toward the breaker over a long session.
    resetPushBudget();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("get:sync-ok"));
    }
  }
}

/**
 * Manual push from the Settings page — uploads ALL shards regardless of
 * dirty flags. `force` is retained for API compatibility but currently
 * has no separate code path: manual push always uploads unconditionally.
 */
export async function pushManual(_force = false): Promise<void> {
  void _force;
  const syncId = getSyncId();
  if (!syncId) throw new Error("no syncId");

  // An explicit user action clears the circuit breaker — they've likely
  // fixed whatever was wrong (reconnected, freed space) and are asking
  // us to try again.
  resetPushBudget();

  // Manual upload = "I want everything up now". Flag all shards dirty and
  // push them. This is also the path used to complete the initial legacy
  // migration.
  for (const s of ALL_SHARDS) dirty.add(s);
  const { failed } = await pushShards(ALL_SHARDS);
  if (failed.length > 0) {
    const summary = failed
      .map((f) => `${f.shard}: ${f.error}`)
      .join("; ");
    throw new Error(`部分分片上传失败：${summary}`);
  }
}

// ---------------------------------------------------------------------------
// Debounced auto-push
// ---------------------------------------------------------------------------
let pushTimer: ReturnType<typeof setTimeout> | null = null;

export function schedulePush(delayMs = 3000): void {
  if (typeof window === "undefined") return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    push().catch((e) => console.warn("[sync] push failed:", e));
  }, delayMs);
}

/**
 * Cancel any pending debounced push and push immediately. Used for
 * low-frequency but high-value actions (like recording a daily punch-in)
 * where we can't afford to lose the write if the user closes the tab
 * within the 3 s debounce window.
 */
export function flushPush(): void {
  if (typeof window === "undefined") return;
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  push().catch((e) => console.warn("[sync] flush push failed:", e));
}
