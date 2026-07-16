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
  getPreferences,
  replacePreferences,
  type Preferences,
} from "@/lib/wordbook/preferences";

// ---------------------------------------------------------------------------
// Sync ID (persisted in localStorage)
// ---------------------------------------------------------------------------
const SYNC_ID_KEY = "get:syncId:v1";

export function getSyncId(): string {
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

/** Overwrite the local syncId — used when user enters a code from another device */
export function setSyncId(id: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SYNC_ID_KEY, id);
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
}

function buildSnapshot(): SyncSnapshot {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    wordbook: readWordbookRaw(),
    wordNotes: readWordNotesRaw(),
    notebook: readNotebookRaw(),
    notebookNotes: readNotebookNotesRaw(),
    punches: listPunches(),
    preferences: getPreferences(),
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
  const mergedPunches = mergePunches(listPunches(), remote.punches ?? []);

  writeWordbookRaw(mergedWordbook);
  writeWordNotesRaw(mergedWordNotes);
  writeNotebookRaw(mergedNotebook);
  writeNotebookNotesRaw(mergedNotebookNotes);
  writePunchesRaw(mergedPunches);
  // Preferences: no timestamp on either side, so just take the remote value
  // if present. Small blob, low stakes; last-write-wins is fine.
  if (remote.preferences) replacePreferences(remote.preferences);

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
