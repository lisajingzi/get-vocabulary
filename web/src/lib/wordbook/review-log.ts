/**
 * Per-day review event log.
 *
 * Records how many review attempts (pass or fail, from any entry point:
 * daily review, wrong-book re-review, etc.) happened on each local day.
 * The calendar surface renders these counts under each date, and the
 * daily "punch-in" is derived from `todayCount() > 0`.
 *
 * Shape: `{ "YYYY-MM-DD": number }` in a single localStorage blob.
 *
 * Idempotency: this is a monotonic counter — every recordReview call
 * bumps today's key by 1, no per-word dedupe. "同一个单词复习两次记为2"
 * per product spec.
 */

const STORAGE_KEY = "get:review-log:v1";

export type ReviewLog = Record<string, number>;

function localDayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function readReviewLog(): ReviewLog {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as ReviewLog;
    return {};
  } catch {
    return {};
  }
}

export function writeReviewLog(log: ReviewLog): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(log));
  window.dispatchEvent(new CustomEvent("get:review-log-change"));
}

/** Bump today's count by 1. Called from every review-result path. */
export function recordReviewEvent(now: Date = new Date()): void {
  const key = localDayKey(now);
  const log = readReviewLog();
  log[key] = (log[key] ?? 0) + 1;
  writeReviewLog(log);
}

/** Get the count for a given calendar day. */
export function countOnDay(iso: string): number {
  const log = readReviewLog();
  return log[iso] ?? 0;
}

/** Today's total count (for the punch-in check). */
export function todayCount(now: Date = new Date()): number {
  return countOnDay(localDayKey(now));
}

/**
 * Merge two review-logs by max-per-day. Used by the cloud-sync layer so
 * two devices reviewing on the same day converge (safer than sum because
 * both devices may already contain overlapping events after a resync).
 */
export function mergeReviewLog(a: ReviewLog, b: ReviewLog): ReviewLog {
  const merged: ReviewLog = { ...a };
  for (const [day, count] of Object.entries(b)) {
    merged[day] = Math.max(merged[day] ?? 0, count);
  }
  return merged;
}
