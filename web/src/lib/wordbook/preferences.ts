/**
 * User-tunable preferences for the review pace.
 *
 * The knobs:
 *   - `dailyCapActive`   \u2014 max review count per day for \u542c\u8bf4\u5199\u8bcd (purpose="active").
 *   - `dailyCapPassive`  \u2014 max review count per day for \u9605\u8bfb\u8bcd  (purpose="passive").
 *
 * Each is `null` (unlimited) or a positive integer. Two knobs instead of
 * one so the user can tune \"heavy\" and \"light\" review load independently.
 *
 * Backwards compatibility:
 *   Older builds stored a single `dailyCap` field. On first read we mirror
 *   its value into BOTH caps so existing users don't lose their setting;
 *   from then on the new fields are the source of truth.
 *
 * Persistence & sync semantics are unchanged \u2014 stored in localStorage under
 * `get:preferences:v1`, mirrored to the cloud snapshot verbatim
 * (last-write-wins across devices). Changing a cap does NOT retroactively
 * resize today's frozen snapshot; the new value applies from tomorrow.
 */

const STORAGE_KEY = "get:preferences:v1";

export interface Preferences {
  /** null = unlimited; otherwise a positive integer cap for \u542c\u8bf4\u5199\u8bcd\u3002 */
  dailyCapActive: number | null;
  /** null = unlimited; otherwise a positive integer cap for \u9605\u8bfb\u8bcd\u3002 */
  dailyCapPassive: number | null;
}

const DEFAULTS: Preferences = {
  dailyCapActive: null,
  dailyCapPassive: null,
};

/** Valid discrete choices offered in the UI. `null` is "unlimited". */
export const DAILY_CAP_CHOICES: Array<number | null> = [null, 10, 20, 30, 50];

/** Shape written to disk. Includes the legacy `dailyCap` field so builds
 *  that pre-date the split can still read something meaningful if they
 *  ever run against this JSON (unlikely, but cheap to keep). */
interface StoredShape {
  dailyCapActive?: number | null;
  dailyCapPassive?: number | null;
  /** Legacy single-cap field, kept only for read-side migration. */
  dailyCap?: number | null;
}

function coerceCap(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v === "number" && v > 0) return Math.floor(v);
  return null;
}

function readRaw(): Preferences {
  if (typeof window === "undefined") return { ...DEFAULTS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<StoredShape>;
    // Migration: if the new fields are missing but the legacy `dailyCap`
    // is present, seed both new fields from it. Otherwise fall through to
    // defaults (unlimited).
    const legacy = parsed.dailyCap !== undefined ? coerceCap(parsed.dailyCap) : undefined;
    const active =
      parsed.dailyCapActive !== undefined
        ? coerceCap(parsed.dailyCapActive)
        : legacy !== undefined
          ? legacy
          : DEFAULTS.dailyCapActive;
    const passive =
      parsed.dailyCapPassive !== undefined
        ? coerceCap(parsed.dailyCapPassive)
        : legacy !== undefined
          ? legacy
          : DEFAULTS.dailyCapPassive;
    return { dailyCapActive: active, dailyCapPassive: passive };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeRaw(prefs: Preferences): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  window.dispatchEvent(new CustomEvent("get:preferences-change"));
}

export function getPreferences(): Preferences {
  return readRaw();
}

export function getDailyCapActive(): number | null {
  return readRaw().dailyCapActive;
}

export function getDailyCapPassive(): number | null {
  return readRaw().dailyCapPassive;
}

export function setDailyCapActive(cap: number | null): void {
  const prefs = readRaw();
  prefs.dailyCapActive = cap === null || cap === undefined ? null : Math.max(1, Math.floor(cap));
  writeRaw(prefs);
}

export function setDailyCapPassive(cap: number | null): void {
  const prefs = readRaw();
  prefs.dailyCapPassive = cap === null || cap === undefined ? null : Math.max(1, Math.floor(cap));
  writeRaw(prefs);
}

/**
 * Legacy alias \u2014 returns the \u542c\u8bf4\u5199 cap so pre-split call sites keep
 * working. New code should prefer `getDailyCapActive` / `getDailyCapPassive`.
 */
export function getDailyCap(): number | null {
  return readRaw().dailyCapActive;
}

/** Legacy alias \u2014 writes BOTH caps to the same value. Kept only for any
 *  code path that hasn't been updated to the new split yet. */
export function setDailyCap(cap: number | null): void {
  const prefs = readRaw();
  const v = cap === null || cap === undefined ? null : Math.max(1, Math.floor(cap));
  prefs.dailyCapActive = v;
  prefs.dailyCapPassive = v;
  writeRaw(prefs);
}

/**
 * Overwrite the entire preferences blob \u2014 used by the cloud sync layer
 * when a remote snapshot is pulled in. We take the remote value verbatim
 * (no timestamp-based merge) because preferences are small and the "last
 * device to change wins" model is what the user expects for a settings
 * page.
 *
 * Also handles remote snapshots that still carry the legacy `dailyCap`
 * field \u2014 they get mirrored into both new caps.
 */
export function replacePreferences(
  next: (Partial<Preferences> & { dailyCap?: number | null }) | null | undefined,
): void {
  if (!next) return;
  const cur = readRaw();
  const legacy = next.dailyCap !== undefined ? coerceCap(next.dailyCap) : undefined;
  const merged: Preferences = {
    dailyCapActive:
      next.dailyCapActive !== undefined
        ? coerceCap(next.dailyCapActive)
        : legacy !== undefined
          ? legacy
          : cur.dailyCapActive,
    dailyCapPassive:
      next.dailyCapPassive !== undefined
        ? coerceCap(next.dailyCapPassive)
        : legacy !== undefined
          ? legacy
          : cur.dailyCapPassive,
  };
  writeRaw(merged);
}
