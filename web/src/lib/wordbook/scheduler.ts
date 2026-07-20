/**
 * Ebbinghaus-style spaced repetition scheduler.
 *
 * Behaviour locked in product chat:
 *   - 7 successful reviews graduate a word to "老朋友" (status='old', level=7).
 *   - One failure drops the level by 1 (never below 0).
 *   - "老朋友" never appears in the daily queue — manual review only.
 *   - Daily queue size cap: user-tunable (see lib/wordbook/preferences.ts).
 *     Default is UNLIMITED — every due card is surfaced today so intervals
 *     aren't silently violated by a hardcoded ceiling. Users who want a
 *     gentler pace can pick 10 / 20 / 30 / 50 in /settings.
 *   - Never pads with未到期 cards — that would fight the schedule.
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
import {
  getDailyCapActive,
  getDailyCapPassive,
} from "@/lib/wordbook/preferences";

export const MAX_LEVEL = 7;
/**
 * Legacy hardcoded cap. Kept exported for callers that still reference it,
 * but the runtime cap now comes from `getDailyCapActive()` /
 * `getDailyCapPassive()` in `preferences.ts` and defaults to unlimited.
 * Treat this constant as a suggested UI preset, not a scheduling law.
 */
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
 *      Anything without an explicit schedule is treated as "due" — covers
 *      entries created before scheduling fields existed.
 *   3. Sort due items by oldest lastSeenAt first (least recently practised).
 *   4. Split into two groups by `purpose` (missing = "active"), apply each
 *      group's own cap independently, then merge back into one ordered
 *      queue — still sorted by lastSeenAt so the review page interleaves
 *      them naturally.
 *
 * `caps`:
 *   - `undefined`  → read the user's preferences.
 *   - `{ active?: number|null, passive?: number|null }`  → use verbatim
 *     (either or both keys can be null for unlimited on that side).
 *
 * The user's spec is: pure due-based selection, no padding, but with
 * independent 说写 / 阅读 daily ceilings so 阅读量大不成为说写的障碍。
 */
export interface DailyCaps {
  active?: number | null;
  passive?: number | null;
}

export function pickDailyQueue(
  entries: WordbookEntry[] = listEntries(),
  now: Date = new Date(),
  caps?: DailyCaps,
): WordbookEntry[] {
  const dueBy = now.getTime();
  const due = entries.filter((e) => {
    if (e.status !== "new") return false;
    if (e.level >= MAX_LEVEL) return false;
    // Treat an entry without an explicit due time as immediately due —
    // covers anything created before scheduling fields existed.
    const dueAt = (e as WordbookEntry & { nextReviewAt?: string | null }).nextReviewAt;
    if (!dueAt) return true;
    return new Date(dueAt).getTime() <= dueBy;
  });
  due.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? -1 : 1));

  // Resolve effective caps: explicit values win; undefined falls back to
  // the user's stored preferences.
  const activeCap =
    caps?.active === undefined ? getDailyCapActive() : caps.active;
  const passiveCap =
    caps?.passive === undefined ? getDailyCapPassive() : caps.passive;

  // Partition by purpose (undefined = active for legacy rows), each side
  // gets its own cap slice, then we re-merge in the original lastSeenAt
  // order. Using two counters on a single pass keeps the merged output
  // stable without a second sort.
  let takenActive = 0;
  let takenPassive = 0;
  const out: WordbookEntry[] = [];
  for (const e of due) {
    const isPassive = e.purpose === "passive";
    if (isPassive) {
      if (passiveCap !== null && takenPassive >= passiveCap) continue;
      takenPassive++;
      out.push(e);
    } else {
      if (activeCap !== null && takenActive >= activeCap) continue;
      takenActive++;
      out.push(e);
    }
  }
  return out;
}
