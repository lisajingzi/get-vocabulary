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
function mergeWordbook(
  local: Record<string, WordbookEntry>,
  remote: Record<string, WordbookEntry>,
): Record<string, WordbookEntry> {
  const merged = { ...local };
  for (const [lemma, remoteEntry] of Object.entries(remote)) {
    const localEntry = merged[lemma];
    if (!localEntry || remoteEntry.lastSeenAt > localEntry.lastSeenAt) {
      merged[lemma] = remoteEntry;
    } else {
      // Preserve the higher queryCount even if local is "newer"
      merged[lemma] = {
        ...localEntry,
        queryCount: Math.max(localEntry.queryCount, remoteEntry.queryCount),
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
export async function push(): Promise<void> {
  const syncId = getSyncId();
  if (!syncId) return;
  const snapshot = buildSnapshot();
  const res = await fetch(`/api/cos/sync?syncId=${syncId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snapshot),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error ?? `HTTP ${res.status}`);
  }
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
    res = await fetch(`/api/cos/sync?syncId=${syncId}`);
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
