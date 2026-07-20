/**
 * Local-first punch-in tracking.
 *
 * A "punch-in" is recorded the moment the user empties out their daily review
 * queue (i.e. /review reaches the DoneState). One punch per local calendar
 * day; idempotent on re-entry.
 *
 * We store the set of punched dates as a JSON-encoded array of YYYY-MM-DD
 * strings. The home calendar reads this; the streak counter is computed
 * from it.
 *
 * Why localStorage instead of IndexedDB / Supabase?
 *   - The home page is server-rendered; the punch list has to be available
 *     synchronously in a client component without an awaited DB open.
 *   - On Day 3b cloud sync we'll mirror this list into a `punch_in_days`
 *     table; the local copy stays the source of truth offline.
 */

const STORAGE_KEY = "get:punches:v1";

function localDayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function readPunches(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function writePunches(list: string[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  window.dispatchEvent(new CustomEvent("get:punch-change"));
}

/** Alias for cloud sync layer */
export const writePunchesRaw = writePunches;

/** Record today as a punch-in day. Idempotent. */
export function recordPunchToday(): void {
  const today = localDayKey();
  const all = new Set(readPunches());
  if (all.has(today)) return;
  all.add(today);
  writePunches(Array.from(all).sort());
  // Punch-in is low-frequency but high-value: bypass the 3 s push debounce
  // and flush to the cloud immediately, so we don't lose it if the user
  // closes the tab right after finishing today's review queue.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("get:punch-flush"));
  }
}

/** All punched days, ascending YYYY-MM-DD. */
export function listPunches(): string[] {
  return readPunches().slice().sort();
}

/** Return only the punched days that fall in the given (year, month) — month is 0-based. */
export function punchesInMonth(year: number, month: number): Set<number> {
  const prefix = `${year}-${String(month + 1).padStart(2, "0")}-`;
  const out = new Set<number>();
  for (const day of readPunches()) {
    if (day.startsWith(prefix)) {
      const d = Number(day.slice(prefix.length));
      if (!Number.isNaN(d)) out.add(d);
    }
  }
  return out;
}

/**
 * Current consecutive-day streak counting backward from today.
 * Returns 0 if today isn't punched yet (so the UI doesn't claim a streak the
 * user hasn't earned for the day).
 */
export function currentStreak(now: Date = new Date()): number {
  const punched = new Set(readPunches());
  let streak = 0;
  const cursor = new Date(now);
  // First, require today; then walk backward.
  for (;;) {
    const key = localDayKey(cursor);
    if (!punched.has(key)) break;
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
