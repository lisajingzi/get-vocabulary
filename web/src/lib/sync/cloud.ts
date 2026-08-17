/**
 * Cloud sync — COS backend.
 *
 * Sync model (no login required):
 *   - Each device generates a random UUID ("syncId") stored in localStorage.
 *   - A snapshot is a JSON blob containing all user data
 *     (wordbook entries, word notes, notebook entries, notebook notes, punches).
 *   - Upload: serialise localStorage → PUT /api/cos/sync?syncId=<uuid>
 *   - Download: GET /api/cos/sync?syncId=<uuid> → merge into localStorage
 *   - Merge strategy: "last write wins" per entry (by updatedAt / lastSeenAt).
 *
 * Cross-device setup:
 *   - Device A: share your Sync Code (the UUID, shown in /settings).
 *   - Device B: enter the code in /settings → pull remote snapshot → done.
 *   - From then on both devices use the same UUID and stay in sync.
 *
 * Debouncing:
 *   - Every local write calls `schedulePush()` which debounces by 3 s so rapid
 *     sequential changes don't each fire a PUT.
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

// ---------------------------------------------------------------------------
// Sync ID
// ---------------------------------------------------------------------------
// Single-user mode: the syncId is a fixed constant injected at build time
// via NEXT_PUBLIC_SYNC_ID. This means every device (even after clearing
// localStorage, WeChat cache purge, browser reinstall, etc.) always points
// to the same COS key and therefore always sees the same data — no manual
// "binding" needed. If the env var is missing (e.g. local dev without a
// .env), we fall back to the legacy per-device UUID stored in localStorage.
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
  window.localStorage.setItem(SYNC_ID_KEY, id);
  return id;
}

/**
 * Overwrite the local syncId. In single-user (FIXED_SYNC_ID) mode this is
 * a no-op — there's nothing to change because the id is a build-time
 * constant shared across all devices.
 */
export function setSyncId(id: string): void {
  if (FIXED_SYNC_ID) return;
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SYNC_ID_KEY, id);
}

/** True when the app is running in single-user (fixed syncId) mode. */
export function isSyncIdLocked(): boolean {
  return Boolean(FIXED_SYNC_ID);
}

// ---------------------------------------------------------------------------
// Safety gate — has this session ever pulled successfully?
// ---------------------------------------------------------------------------
// Root cause of an earlier data-loss incident: on cold start, migration
// helpers in SyncProvider dispatch `get:wordbook-change`, which schedules
// a push in 3 s. On slow networks (WeChat WebView) the initial pull hadn't
// finished yet, so buildSnapshot() read an *empty* notebook/punches (they
// hadn't been merged from remote yet) and PUT overwrote the cloud copy
// with blanks. This flag gates all automatic pushes until at least one
// pull has completed, so we never blindly upload a partially-hydrated
// local state. Manual pushes (from the Settings page "Upload" button) go
// through `pushManual()` which explicitly bypasses this gate — the user
// asked for it, they know what they're doing.
let hasPulledOnce = false;
/** For diagnostics only — exposes whether the safety gate is currently open. */
export function isPullGateOpen(): boolean {
  return hasPulledOnce;
}

// Network timeout for sync fetches. Requests that hang past this get
// aborted so callers see a real error instead of a UI stuck on "Syncing…".
const SYNC_FETCH_TIMEOUT_MS = 30_000;
function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = SYNC_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

// ---------------------------------------------------------------------------
// Snapshot shape
// ---------------------------------------------------------------------------
export interface SyncSnapshot {
  version: 1;
  savedAt: string;
  wordbook: Record<string, WordbookEntry>;
  wordNotes: Record<string, WordNote[]>;
  notebook: Record<string, NotebookEntry>;
  notebookNotes: Record<string, NotebookNote[]>;
  punches: string[];
  /**
   * User preferences (review pace, etc). Optional so older snapshots that
   * pre-date this field still parse cleanly.
   */
  preferences?: Preferences;
  /**
   * Today's frozen review queue (lemma list + date). Optional so older
   * snapshots without this field still parse. Sharing this across devices
   * makes the "进度 X/Y" counter identical everywhere — otherwise each
   * device freezes its own 20 words at first-open and users see different
   * queues when they resume review on another device.
   */
  dailySnapshot?: SnapshotPayload;
  /**
   * Per-day review event counts. Records how many review attempts happened
   * each local day (both daily-review and wrong-book re-review). Merged
   * by max-per-day to converge across devices.
   */
  reviewLog?: ReviewLog;
}

function buildSnapshot(): SyncSnapshot {
  const daily = readSnapshotPayload();
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    wordbook: readWordbookRaw(),
    wordNotes: readWordNotesRaw(),
    notebook: readNotebookRaw(),
    notebookNotes: readNotebookNotesRaw(),
    punches: listPunches(),
    preferences: getPreferences(),
    dailySnapshot: daily ?? undefined,
    reviewLog: readReviewLog(),
  };
}

// ---------------------------------------------------------------------------
// Merge helpers — last-write-wins by timestamp
// ---------------------------------------------------------------------------

/**
 * Old bug: the IELTS batch importer used to call `recordLookup` which sets
 * queryCount=1 even though the user never actually looked the word up. We've
 * fixed the writer, but stale remote snapshots may still carry those bogus
 * 1's. Treat any entry that satisfies `queryCount===1 && !lastQueriedAt`
 * as effectively unqueried during merging so the client-side backfill
 * doesn't get resurrected by an old cloud snapshot.
 */
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
      // Even when remote wins by timestamp, sanitize the import-residue
      // queryCount so a fresh device pulling from cloud doesn't inherit
      // the pre-fix "已查过一次" artifact.
      merged[lemma] = {
        ...remoteEntry,
        queryCount: effectiveQueryCount(remoteEntry),
      };
    } else {
      // Preserve the higher queryCount even if local is "newer"
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
// Push (upload local → remote)
// ---------------------------------------------------------------------------

/**
 * How many entries are in each non-wordbook store right now. Used by the
 * safety gate to detect "the local state looks suspiciously empty relative
 * to what the cloud already has" and refuse to overwrite the cloud.
 */
function countLocalNonWordbook(snapshot: SyncSnapshot): {
  notebook: number;
  notebookNotes: number;
  wordNotes: number;
  punches: number;
} {
  const nn = Object.values(snapshot.notebookNotes ?? {}).reduce(
    (s, arr) => s + arr.length,
    0,
  );
  const wn = Object.values(snapshot.wordNotes ?? {}).reduce(
    (s, arr) => s + arr.length,
    0,
  );
  return {
    notebook: Object.keys(snapshot.notebook ?? {}).length,
    notebookNotes: nn,
    wordNotes: wn,
    punches: (snapshot.punches ?? []).length,
  };
}

/**
 * Internal core push. Uploads the current localStorage snapshot to COS.
 * Callers should prefer `push()` (auto, gated) or `pushManual()` (user
 * initiated, bypasses the gate but still runs the safety net).
 */
async function pushCore(): Promise<void> {
  const syncId = getSyncId();
  if (!syncId) return;
  const snapshot = buildSnapshot();
  const res = await fetchWithTimeout(`/api/cos/sync?syncId=${syncId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snapshot),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error ?? `HTTP ${res.status}`);
  }
}

/**
 * Compares the built local snapshot against the current cloud snapshot.
 * Returns a reason string if the push should be refused (because local
 * looks catastrophically emptier than remote), or null if it's safe.
 *
 * Only guards the *automatic* push path. Manual push from Settings shows
 * a confirm dialog to the user instead.
 */
async function detectSuspiciousEmptyPush(
  local: SyncSnapshot,
): Promise<string | null> {
  const syncId = getSyncId();
  if (!syncId) return null;
  let remote: SyncSnapshot | null = null;
  try {
    const res = await fetchWithTimeout(`/api/cos/sync?syncId=${syncId}`);
    if (res.ok) remote = await res.json();
  } catch {
    // Network hiccup on the HEAD check — don't block push over that.
    return null;
  }
  if (!remote) return null; // no cloud snapshot yet, nothing to protect

  const localCounts = countLocalNonWordbook(local);
  const remoteCounts = countLocalNonWordbook(remote);

  // Danger sign: for every non-wordbook store, remote has data and local
  // has none. Almost certainly a bug (partial hydration, race condition,
  // wrong syncId, etc), not a legitimate reset.
  const emptied =
    remoteCounts.notebook > 0 &&
    localCounts.notebook === 0 &&
    remoteCounts.punches > 0 &&
    localCounts.punches === 0;
  if (emptied) {
    return (
      `Refusing to push: local looks empty vs cloud ` +
      `(local notebook=${localCounts.notebook}, punches=${localCounts.punches}; ` +
      `cloud notebook=${remoteCounts.notebook}, punches=${remoteCounts.punches}). ` +
      `This usually means the initial pull hasn't finished yet.`
    );
  }
  return null;
}

/**
 * Auto push (called by the debounced scheduler on data changes). Skips
 * the network entirely if:
 *   - No pull has ever succeeded this session (initial hydration might
 *     still be in flight — pushing now risks blanking the cloud).
 *   - The safety net thinks local is catastrophically emptier than cloud.
 */
export async function push(): Promise<void> {
  if (!hasPulledOnce) {
    console.warn(
      "[sync] auto-push skipped: initial pull hasn't completed yet",
    );
    return;
  }
  const syncId = getSyncId();
  if (!syncId) return;
  const snapshot = buildSnapshot();
  const reason = await detectSuspiciousEmptyPush(snapshot);
  if (reason) {
    console.error(`[sync] auto-push refused. ${reason}`);
    return;
  }
  await pushCore();
}

/**
 * Manual push initiated from the Settings page. Bypasses the pull gate
 * (the user explicitly clicked Upload) but still runs the emptiness
 * safety net and throws with a descriptive message so the UI can surface
 * a confirm-to-override dialog.
 *
 * If `force` is true the safety net is also skipped — reserved for the
 * "Yes, I really do want to overwrite" path in the confirm dialog.
 */
export async function pushManual(force = false): Promise<void> {
  const syncId = getSyncId();
  if (!syncId) throw new Error("no syncId");
  const snapshot = buildSnapshot();
  if (!force) {
    const reason = await detectSuspiciousEmptyPush(snapshot);
    if (reason) {
      const err = new Error(reason);
      (err as Error & { code?: string }).code = "SUSPICIOUS_EMPTY_PUSH";
      throw err;
    }
  }
  await pushCore();
}

// ---------------------------------------------------------------------------
// Pull (download remote → merge into local)
// ---------------------------------------------------------------------------
export async function pull(overrideSyncId?: string): Promise<{
  merged: boolean;
  error?: string;
}> {
  const syncId = overrideSyncId ?? getSyncId();
  if (!syncId) return { merged: false, error: "no syncId" };

  let res: Response;
  try {
    res = await fetchWithTimeout(`/api/cos/sync?syncId=${syncId}`);
  } catch (e) {
    return { merged: false, error: String(e) };
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { merged: false, error: err?.error ?? `HTTP ${res.status}` };
  }

  const remote: SyncSnapshot | null = await res.json();
  if (!remote) return { merged: false }; // no remote snapshot yet, nothing to do

  // Merge each store
  const mergedWordbook = mergeWordbook(readWordbookRaw(), remote.wordbook ?? {});
  const mergedWordNotes = mergeNoteMaps(
    readWordNotesRaw(),
    remote.wordNotes ?? {},
  );
  const mergedNotebook = mergeNotebook(
    readNotebookRaw(),
    remote.notebook ?? {},
  );
  const mergedNotebookNotes = mergeNoteMaps(
    readNotebookNotesRaw(),
    remote.notebookNotes ?? {},
  );
  const localPunches = listPunches();
  const mergedPunches = mergePunches(localPunches, remote.punches ?? []);

  writeWordbookRaw(mergedWordbook);
  writeWordNotesRaw(mergedWordNotes);
  writeNotebookRaw(mergedNotebook);
  writeNotebookNotesRaw(mergedNotebookNotes);
  writePunchesRaw(mergedPunches);

  // Open the auto-push safety gate: the initial hydration completed, so
  // any subsequent local writes are now safe to schedule pushes for.
  hasPulledOnce = true;
  // Preferences: no timestamp on either side, so just take the remote value
  // if present. Small blob, low stakes; last-write-wins is fine.
  if (remote.preferences) replacePreferences(remote.preferences);

  // Review log — merge by max-per-day.
  if (remote.reviewLog) {
    const merged = mergeReviewLog(readReviewLog(), remote.reviewLog);
    writeReviewLog(merged);
  }

  // If today's snapshot was frozen empty *before* this pull merged data in
  // (typical on a device that just bound to an existing sync code), drop it
  // so the next read refreezes against the fresh wordbook. Non-empty
  // snapshots are preserved to keep the "new words wait for tomorrow" rule.
  invalidateSnapshotIfEmpty();

  // Merge today's frozen review queue across devices. Rule:
  //   - If remote has a snapshot for today, adopt it (cloud is the shared
  //     source of truth for "which 20 words are we tackling today").
  //   - If local has a snapshot for today and remote doesn't, keep local
  //     as-is — the sync push triggered by writeRaw will upload it soon.
  //   - If both are today but with different lemma lists (rare: two devices
  //     both froze independently before this feature deployed, or a race),
  //     union the lemmas so no word gets dropped. The device that pulls
  //     first "absorbs" the other side's queue.
  //   - If remote's snapshot is from an earlier day (yesterday), ignore it
  //     and let today's local logic freeze a fresh one.
  const remoteDaily = remote.dailySnapshot;
  const localDaily = readSnapshotPayload();
  const today = new Date();
  const localDay = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (remoteDaily && remoteDaily.date === localDay) {
    if (!localDaily || localDaily.date !== localDay) {
      applyRemoteSnapshot(remoteDaily);
    } else {
      const union = Array.from(
        new Set([...localDaily.lemmas, ...remoteDaily.lemmas]),
      );
      const sameSet =
        union.length === localDaily.lemmas.length &&
        union.length === remoteDaily.lemmas.length;
      if (!sameSet) {
        applyRemoteSnapshot({ date: localDay, lemmas: union });
      }
    }
  }

  // Fallback safety net: if the local snapshot contained punches that the
  // remote didn't yet have (typical when a previous push was aborted before
  // the 3 s debounce fired), immediately push the merged snapshot back so
  // other devices can see them on their next pull. Also trigger a push
  // when we just adopted or unioned today's daily snapshot above, so the
  // cloud copy converges to the merged version.
  const remotePunchSet = new Set(remote.punches ?? []);
  const localHasExtraPunches = localPunches.some((d) => !remotePunchSet.has(d));
  const localHasFresherDaily =
    !!localDaily &&
    localDaily.date === localDay &&
    (!remoteDaily ||
      remoteDaily.date !== localDay ||
      localDaily.lemmas.some((l) => !remoteDaily.lemmas.includes(l)));
  if (localHasExtraPunches || localHasFresherDaily) {
    push().catch((e) => console.warn("[sync] catch-up push failed:", e));
  }

  return { merged: true };
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
 * Cancel any pending debounced push and push immediately. Used for low-
 * frequency but high-value actions (like recording a daily punch-in) where
 * we can't afford to lose the write if the user closes the tab within the
 * 3 s debounce window.
 */
export function flushPush(): void {
  if (typeof window === "undefined") return;
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  push().catch((e) => console.warn("[sync] flush push failed:", e));
}
