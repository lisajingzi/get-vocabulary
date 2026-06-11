/**
 * Ebbinghaus-style spaced repetition scheduler.
 *
 * Behaviour locked in product chat:
 *   - 7 successful reviews graduate a word to "老朋友" (status='old', level=7).
 *   - One failure drops the level by 1 (never below 0).
 *   - "老朋友" never appears in the daily queue — manual review only.
 *   - Daily queue size cap = 10. If wordbook has fewer due items, take what
 *     we have (don't pad with未到期 cards — that fights the schedule).
 *   - Sources: ALL "新朋友" entries the user has ever looked up, not just
 *     today's lookups.
 *
 * Intervals are conventional Ebbinghaus-ish steps in days, indexed by the
 * level the card is AT when scheduled:
 *   level 0 → due now
 *   level 1 → 1 day
 *   level 2 → 2 days
 *   level 3 → 4 days
 *   level 4 → 7 days
 *   level 5 → 15 days
 *   level 6 → 30 days
 *   level 7 → graduated (no schedule)
 */

import { listEntries, type WordbookEntry } from "@/lib/wordbook/local";

export const MAX_LEVEL = 7;
export const DAILY_QUEUE_CAP = 10;

const INTERVAL_DAYS = [0, 1, 2, 4, 7, 15, 30] as const;

function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

/**
 * Compute the next scheduled review time given the new level + a "now" anchor.
 * Returns null for graduated cards.
 */
export function nextReviewAt(level: number, now: Date = new Date()): string | null {
  if (level >= MAX_LEVEL) return null;
  const days = INTERVAL_DAYS[Math.max(0, Math.min(level, INTERVAL_DAYS.length - 1))];
  return addDays(now.toISOString(), days);
}

/**
 * Apply a review result to an entry's level. Returns the resulting level
 * (caller persists). Pure function — no side effects.
 */
export function applyReviewResult(
  level: number,
  result: "pass" | "fail",
): number {
  if (result === "pass") return Math.min(MAX_LEVEL, level + 1);
  return Math.max(0, level - 1);
}

/**
 * Pick today's queue.
 *
 * Strategy:
 *   1. Filter to status === 'new' AND level < MAX_LEVEL.
 *   2. Prefer entries whose `nextReviewAt` is null OR <= now (i.e. due).
 *      We track the schedule on `lastSeenAt` rather than introducing a new
 *      field so this works for entries created before the scheduler shipped:
 *      anything without an explicit schedule is treated as "due".
 *   3. Sort due items by oldest lastSeenAt first (least recently practised),
 *      then take up to DAILY_QUEUE_CAP.
 *
 * The user's spec said: "如果凑不满就不用凑了；没有查新词也可以复习以前查过的词".
 * That's what this gives them — pure due-based selection, no padding.
 */
export function pickDailyQueue(
  entries: WordbookEntry[] = listEntries(),
  now: Date = new Date(),
): WordbookEntry[] {
  const dueBy = now.getTime();
  const due = entries.filter((e) => {
    if (e.status !== "new") return false;
    if (e.level >= MAX_LEVEL) return false;
    // Treat an entry without an explicit due time as immediately due —
    // covers anything created before scheduling fields existed.
    const due = (e as WordbookEntry & { nextReviewAt?: string | null }).nextReviewAt;
    if (!due) return true;
    return new Date(due).getTime() <= dueBy;
  });
  due.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? -1 : 1));
  return due.slice(0, DAILY_QUEUE_CAP);
}
