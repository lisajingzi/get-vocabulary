/**
 * One-time migration: hoist legacy inline base64 images out of the JSON
 * shards and into standalone COS objects.
 *
 * Why this exists
 * ---------------
 * Note `image` fields used to hold full `data:image/...;base64,...` URLs.
 * `lib/wordbook/image.ts` stopped inlining NEW images (they go to COS and
 * only a short `cos:/sync/<id>/images/<uuid>.jpeg` reference is stored),
 * but the historical ones were left in place with the reasoning that
 * "current shard size is already acceptable".
 *
 * That turned out to be wrong, and expensively so:
 *   - A single 1200px JPEG is ~150 KB raw, ~200 KB once base64-encoded.
 *     A few dozen of them push `wordNotes` / `notebookNotes` /
 *     `stringNotes` into the multi-MB range.
 *   - Every cloud pull re-downloads those megabytes through the
 *     /api/cos/sync function, and every push re-uploads them. On Vercel
 *     that traffic is billed as Fast Origin Transfer (CDN <-> function),
 *     which on the Hobby plan is capped at 10 GB/month.
 *   - Worse, oversized PUTs time out on mobile networks, and the retry
 *     machinery then re-sends the whole multi-MB payload again. The
 *     original "cloud sync keeps failing" symptom and the quota blowout
 *     are the SAME root cause.
 *
 * After migration the three note shards hold only short `cos:` reference
 * strings, so they shrink by one to two orders of magnitude. Sync stops
 * timing out and origin transfer collapses.
 *
 * Safety properties
 * -----------------
 *   - Idempotent. A localStorage flag records completion, and even
 *     without the flag the scan simply finds no `data:` images and exits.
 *   - Non-destructive on failure. A note's base64 is replaced ONLY after
 *     its COS upload has returned a key. Any upload that fails leaves the
 *     original data URL untouched, so the image is never lost; the next
 *     run retries just that one.
 *   - Incremental persistence. Progress is written back after each store
 *     finishes rather than at the very end, so a tab closed mid-migration
 *     keeps whatever was already converted.
 *   - Rate-limited. Uploads run in small sequential batches to avoid
 *     hammering the function with dozens of concurrent POSTs (which is
 *     what got the account paused in the first place).
 *   - Read-only with respect to cloud state. We only touch local stores
 *     and mark shards dirty; the regular push path does the uploading.
 */

import {
  readNotes as readWordNotes,
  writeNotes as writeWordNotes,
  type WordNote,
} from "@/lib/wordbook/local";
import {
  readNotesStore as readNotebookNotes,
  writeNotesStore as writeNotebookNotes,
  type NotebookNote,
} from "@/lib/notebook/local";
import {
  readStore as readStringNotes,
  writeStore as writeStringNotes,
  type StringNote,
} from "@/lib/wordbook/string-notes";
import { getSyncId, markDirty, type ShardName } from "@/lib/sync/cloud";

/** Bumped if we ever need to force a re-scan on already-migrated clients. */
const MIGRATION_KEY = "get:image-migrate:v1";

/**
 * Upload concurrency. Deliberately small: these are multi-hundred-KB
 * POSTs through a serverless function, and the whole point of this
 * migration is to stop abusing that function.
 */
const BATCH_SIZE = 2;

/** Pause between batches so a large backlog doesn't saturate the network. */
const BATCH_PAUSE_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isImageMigrationDone(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return Boolean(window.localStorage.getItem(MIGRATION_KEY));
  } catch {
    // localStorage unavailable — treat as done so we never loop forever.
    return true;
  }
}

function markImageMigrationDone(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MIGRATION_KEY, String(Date.now()));
  } catch {
    /* quota — harmless, we just re-scan next boot and find nothing */
  }
}

/** Is this `image` field a legacy inline base64 data URL? */
function isInlineImage(value: string | undefined | null): value is string {
  return typeof value === "string" && value.startsWith("data:");
}

/**
 * Decode a `data:<mime>;base64,<payload>` URL into a Blob.
 * Returns null for anything malformed so a single corrupt row can't
 * abort the whole migration.
 */
function dataUrlToBlob(dataUrl: string): { blob: Blob; ext: string } | null {
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!match) return null;
  const mime = match[1] || "image/jpeg";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? "";
  if (!payload) return null;

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    if (isBase64) {
      const binary = atob(payload);
      // Allocate a plain ArrayBuffer explicitly: the default Uint8Array
      // backing store is typed as ArrayBufferLike, which TypeScript won't
      // accept as a BlobPart.
      const buffer = new ArrayBuffer(binary.length);
      bytes = new Uint8Array(buffer);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
    } else {
      const encoded = new TextEncoder().encode(decodeURIComponent(payload));
      const buffer = new ArrayBuffer(encoded.length);
      bytes = new Uint8Array(buffer);
      bytes.set(encoded);
    }
  } catch {
    return null;
  }
  if (bytes.byteLength === 0) return null;

  // Map mime → the extension the /api/cos/image route accepts.
  const subtype = mime.split("/")[1]?.toLowerCase() ?? "jpeg";
  const ext = subtype === "jpg" ? "jpeg" : subtype;
  const ALLOWED = new Set(["jpeg", "png", "webp", "gif"]);
  if (!ALLOWED.has(ext)) return null;

  return { blob: new Blob([bytes], { type: mime }), ext };
}

/**
 * Upload one decoded blob and return its `cos:` key, or null on failure.
 * Never throws — callers treat null as "leave the original alone".
 */
async function uploadBlob(
  syncId: string,
  blob: Blob,
  ext: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `/api/cos/image?syncId=${encodeURIComponent(syncId)}&ext=${ext}`,
      {
        method: "POST",
        headers: { "Content-Type": blob.type || `image/${ext}` },
        body: blob,
      },
    );
    if (!res.ok) {
      console.warn("[image-migrate] upload failed", res.status);
      return null;
    }
    const body = (await res.json()) as { key?: string };
    if (!body?.key || !body.key.startsWith("cos:")) return null;
    return body.key;
  } catch (e) {
    console.warn("[image-migrate] upload error", e);
    return null;
  }
}

/**
 * A single image that needs converting, described generically so one
 * batch runner can serve all three store shapes. `apply` writes the new
 * key back into whatever structure the item came from.
 */
interface PendingImage {
  dataUrl: string;
  apply: (key: string) => void;
}

/**
 * Upload every pending image in small sequential batches.
 * Returns how many succeeded. Mutates via each item's `apply`.
 */
async function runBatches(
  syncId: string,
  pending: PendingImage[],
): Promise<number> {
  let converted = 0;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const keys = await Promise.all(
      batch.map(async (item) => {
        const decoded = dataUrlToBlob(item.dataUrl);
        if (!decoded) return null;
        return uploadBlob(syncId, decoded.blob, decoded.ext);
      }),
    );
    keys.forEach((key, idx) => {
      if (key) {
        batch[idx].apply(key);
        converted += 1;
      }
    });
    if (i + BATCH_SIZE < pending.length) await sleep(BATCH_PAUSE_MS);
  }
  return converted;
}

/** Per-store migration result, aggregated into the public return value. */
interface StoreResult {
  found: number;
  converted: number;
}

/** wordNotes: Record<lemma, WordNote[]> */
async function migrateWordNotes(syncId: string): Promise<StoreResult> {
  const store = readWordNotes();
  // Deep-ish clone so a partial failure can't leave the live cache in a
  // half-mutated state; we only write back when something changed.
  const next: Record<string, WordNote[]> = {};
  const pending: PendingImage[] = [];

  for (const [lemma, notes] of Object.entries(store)) {
    next[lemma] = notes.map((note) => {
      const copy: WordNote = { ...note };
      if (isInlineImage(copy.image)) {
        const dataUrl = copy.image;
        pending.push({
          dataUrl,
          apply: (key) => {
            copy.image = key;
          },
        });
      }
      return copy;
    });
  }

  if (pending.length === 0) return { found: 0, converted: 0 };
  const converted = await runBatches(syncId, pending);
  if (converted > 0) {
    writeWordNotes(next);
    markDirty("wordNotes");
  }
  return { found: pending.length, converted };
}

/** notebookNotes: Record<entryId, NotebookNote[]> */
async function migrateNotebookNotes(syncId: string): Promise<StoreResult> {
  const store = readNotebookNotes();
  const next: Record<string, NotebookNote[]> = {};
  const pending: PendingImage[] = [];

  for (const [entryId, notes] of Object.entries(store)) {
    next[entryId] = notes.map((note) => {
      const copy: NotebookNote = { ...note };
      if (isInlineImage(copy.image)) {
        const dataUrl = copy.image;
        pending.push({
          dataUrl,
          apply: (key) => {
            copy.image = key;
          },
        });
      }
      return copy;
    });
  }

  if (pending.length === 0) return { found: 0, converted: 0 };
  const converted = await runBatches(syncId, pending);
  if (converted > 0) {
    writeNotebookNotes(next);
    markDirty("notebookNotes");
  }
  return { found: pending.length, converted };
}

/** stringNotes: Record<id, StringNote> */
async function migrateStringNotes(syncId: string): Promise<StoreResult> {
  const store = readStringNotes();
  const next: Record<string, StringNote> = {};
  const pending: PendingImage[] = [];

  for (const [id, note] of Object.entries(store)) {
    const copy: StringNote = { ...note };
    if (isInlineImage(copy.image)) {
      const dataUrl = copy.image;
      pending.push({
        dataUrl,
        apply: (key) => {
          copy.image = key;
        },
      });
    }
    next[id] = copy;
  }

  if (pending.length === 0) return { found: 0, converted: 0 };
  const converted = await runBatches(syncId, pending);
  if (converted > 0) {
    writeStringNotes(next);
    markDirty("stringNotes");
  }
  return { found: pending.length, converted };
}

export interface ImageMigrationReport {
  /** True if the migration actually ran (vs. skipped as already done). */
  ran: boolean;
  /** Total legacy inline images discovered across all three stores. */
  found: number;
  /** How many were successfully uploaded and dereferenced. */
  converted: number;
}

/**
 * Run the migration across all three note stores.
 *
 * MUST be called only after the IndexedDB hydrators have resolved —
 * otherwise the in-memory caches are empty and we'd see nothing to do
 * (and worse, writing back would blank the stores). SyncProvider
 * sequences this correctly.
 *
 * The migration deliberately does NOT push to the cloud itself. It marks
 * the affected shards dirty and lets the normal debounced pusher handle
 * upload, so all the usual retry / gating logic applies.
 */
export async function migrateInlineImages(opts?: {
  force?: boolean;
}): Promise<ImageMigrationReport> {
  if (typeof window === "undefined") {
    return { ran: false, found: 0, converted: 0 };
  }
  if (!opts?.force && isImageMigrationDone()) {
    return { ran: false, found: 0, converted: 0 };
  }

  const syncId = getSyncId();
  if (!syncId) {
    // No sync id yet — we can't address COS objects. Don't set the done
    // flag; the next boot will retry.
    return { ran: false, found: 0, converted: 0 };
  }

  let found = 0;
  let converted = 0;

  // Sequential across stores (not parallel) so total in-flight uploads
  // stay bounded by BATCH_SIZE rather than BATCH_SIZE * 3.
  const stores: Array<{ name: ShardName; run: () => Promise<StoreResult> }> = [
    { name: "wordNotes", run: () => migrateWordNotes(syncId) },
    { name: "notebookNotes", run: () => migrateNotebookNotes(syncId) },
    { name: "stringNotes", run: () => migrateStringNotes(syncId) },
  ];

  for (const store of stores) {
    try {
      const result = await store.run();
      found += result.found;
      converted += result.converted;
    } catch (e) {
      console.warn(`[image-migrate] ${store.name} failed`, e);
    }
  }

  // Only declare victory when every discovered image made it across.
  // A partial run leaves the flag unset so the next boot picks up the
  // stragglers — the already-converted ones are skipped automatically
  // because they no longer start with "data:".
  if (found === converted) {
    markImageMigrationDone();
  } else {
    console.warn(
      `[image-migrate] partial: ${converted}/${found} converted; will retry next boot`,
    );
  }

  if (found > 0) {
    console.info(
      `[image-migrate] converted ${converted}/${found} inline images to COS objects`,
    );
  }

  return { ran: true, found, converted };
}
