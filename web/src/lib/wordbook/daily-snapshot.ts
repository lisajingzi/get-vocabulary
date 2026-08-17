/**
 * Daily review-queue snapshot.
 *
 * Why this file exists:
 *   The home page shows a "进度 X/Y" counter for today's review. We want
 *   that fraction to behave intuitively:
 *     - Y = how many words the user is *expected* to review today.
 *     - X = how many of those have actually been reviewed today.
 *
 *   If we recompute Y on the fly via `pickDailyQueue` every render, two
 *   awkward things happen:
 *     1. Looking up a brand-new word mid-day inflates Y (the new card is
 *        immediately due) — confusing.
 *     2. Moving a 老朋友 back to 新朋友 inflates Y too, because that card is
 *        now eligible for the daily queue.
 *
 *   The product decision (locked in chat 2026-06-30): freeze Y at the first
 *   moment of the day we read it. Any cards added or unarchived later that
 *   day go to *tomorrow's* queue. Cards moved OUT of 新朋友 during the day
 *   should drop out of Y (you no longer have to review them). Cards reviewed
 *   today (lastReviewedAt === today) count toward X, but ONLY if they were
 *   in today's snapshot — reviewing a word that joined the wordbook later
 *   in the day shouldn't bump the bar.
 *
 *   So: store the snapshot of lemmas once per local day, and let the
 *   counters derive themselves from current entry state filtered by that
 *   snapshot.
 */

import { listEntries, type WordbookEntry } from "@/lib/wordbook/local";
import { pickDailyQueue, MAX_LEVEL } from "@/lib/wordbook/scheduler";

const STORAGE_KEY = "get:daily-snapshot:v1";

export interface SnapshotPayload {
  /** Local YYYY-MM-DD the snapshot was captured on. */
  date: string;
  /** Lemmas (lowercased keys) frozen as "today's review queue". */
  lemmas: string[];
}

function localDayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function readRaw(): SnapshotPayload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SnapshotPayload;
    if (!parsed || typeof parsed.date !== "string" || !Array.isArray(parsed.lemmas)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeRaw(payload: SnapshotPayload): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.error("[wordbook/daily-snapshot] writeRaw failed", e);
    throw e;
  }
  window.dispatchEvent(new CustomEvent("get:daily-snapshot-change"));
  // Extra event fired ONLY when the local device freezes its own snapshot
  // (as opposed to receiving one from the cloud via `applyRemoteSnapshot`).
  // The cloud-sync layer listens to this to push the freshly frozen queue
  // so all devices land on the same daily lemma set.
  window.dispatchEvent(new CustomEvent("get:daily-snapshot-local-write"));
}

/**
 * Read the raw stored snapshot payload (SSR-safe: returns null on the server).
 * Exposed for the cloud-sync layer so it can package the snapshot into the
 * cross-device SyncSnapshot blob.
 */
export function readSnapshotPayload(): SnapshotPayload | null {
  return readRaw();
}

/**
 * Overwrite the local snapshot with a payload received from the cloud
 * (or merged remote+local). Silently no-ops on the server. Dispatches the
 * standard change event so the home progress card re-renders. Does NOT
 * schedule another push — caller decides whether the write originated
 * locally (push-worthy) or from a pull (would loop).
 */
export function applyRemoteSnapshot(payload: SnapshotPayload): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.error("[wordbook/daily-snapshot] applyRemoteSnapshot failed", e);
    throw e;
  }
  window.dispatchEvent(new CustomEvent("get:daily-snapshot-change"));
}

/**
 * Return the set of lemmas frozen as "today's queue", creating one if
 * the stored snapshot is missing or stale (i.e. dated to a previous day).
 *
 * SSR-safe: returns an empty set when called on the server.
 */
export function getTodaySnapshot(now: Date = new Date()): Set<string> {
  if (typeof window === "undefined") return new Set();
  const today = localDayKey(now);
  const existing = readRaw();
  if (existing && existing.date === today) {
    return new Set(existing.lemmas);
  }
  // First read of the day (or first ever): freeze whatever pickDailyQueue
  // says is due right now and persist it.
  const queue = pickDailyQueue(listEntries(), now);
  const lemmas = queue.map((e) => e.lemma);
  writeRaw({ date: today, lemmas });
  return new Set(lemmas);
}

/**
 * Today's progress counters, derived from the snapshot + current entry state.
 *
 *   total     — words in today's snapshot that are still 新朋友 and not yet
 *               graduated. (Moves to 老朋友 / archived shrink this.)
 *   finished  — subset of `total` that have lastReviewedAt === today.
 *   remaining — total - finished (== how many genuinely still due today).
 *
 * `active` and `passive` break the same numbers down by the entry's
 * `purpose` (missing = "active") so the home page can show:
 *   听说写 3/10 · 阅读 5/20
 * and the settings page can advise on caps.
 */
export interface DailyProgressBucket {
  total: number;
  finished: number;
  remaining: number;
}

export interface DailyProgress extends DailyProgressBucket {
  active: DailyProgressBucket;
  passive: DailyProgressBucket;
}

/**
 * Drop today's frozen snapshot if it is empty.
 *
 * Called after a successful cloud pull on a device that had no local data
 * yet: the snapshot would have been frozen to an empty queue *before* the
 * pull merged remote words in, which then makes "开始复习" stay disabled
 * for the rest of the day. Clearing the empty snapshot lets the next read
 * refreeze it against the freshly-merged wordbook.
 *
 * Non-empty snapshots are left alone — that preserves the product rule
 * "words added mid-day go to tomorrow's queue".
 */
export function invalidateSnapshotIfEmpty(): void {
  if (typeof window === "undefined") return;
  const existing = readRaw();
  if (!existing) return;
  if (existing.lemmas.length > 0) return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new CustomEvent("get:daily-snapshot-change"));
}

export function getDailyProgress(now: Date = new Date()): DailyProgress {
  const snapshot = getTodaySnapshot(now);
  const empty: DailyProgressBucket = { total: 0, finished: 0, remaining: 0 };
  if (snapshot.size === 0) {
    return { ...empty, active: { ...empty }, passive: { ...empty } };
  }
  const today = localDayKey(now);
  const entries = listEntries();
  const byLemma = new Map<string, WordbookEntry>();
  for (const e of entries) byLemma.set(e.lemma, e);

  const buckets = {
    active: { total: 0, finished: 0 },
    passive: { total: 0, finished: 0 },
  };
  snapshot.forEach((lemma) => {
    const e = byLemma.get(lemma);
    // Entry vanished (e.g. cleared) — drop from total.
    if (!e) return;
    // Status moved out of 新朋友 (graduated to 老朋友 or archived) — drop.
    if (e.status !== "new") return;
    // Already maxed out level — drop (defensive; shouldn't happen for new).
    if (e.level >= MAX_LEVEL) return;
    const bucket = e.purpose === "passive" ? buckets.passive : buckets.active;
    bucket.total++;
    if (e.lastReviewedAt && localDayKey(new Date(e.lastReviewedAt)) === today) {
      bucket.finished++;
    }
  });
  const active: DailyProgressBucket = {
    total: buckets.active.total,
    finished: buckets.active.finished,
    remaining: Math.max(0, buckets.active.total - buckets.active.finished),
  };
  const passive: DailyProgressBucket = {
    total: buckets.passive.total,
    finished: buckets.passive.finished,
    remaining: Math.max(0, buckets.passive.total - buckets.passive.finished),
  };
  const total = active.total + passive.total;
  const finished = active.finished + passive.finished;
  return {
    total,
    finished,
    remaining: Math.max(0, total - finished),
    active,
    passive,
  };
}
