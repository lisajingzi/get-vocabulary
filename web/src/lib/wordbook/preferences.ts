/**
 * User-tunable preferences for the review pace.
 *
 * Currently the only knob is `dailyCap`:
 *   - null  → unlimited (default) — every due card enters today's queue,
 *             following strict Ebbinghaus timing.
 *   - N (positive integer) → hard cap on today's queue size. Any due cards
 *             beyond the cap simply roll into subsequent days
 *             (their `nextReviewAt` stays in the past, so they'll be picked
 *             again first thing tomorrow).
 *
 * Why default = unlimited:
 *   The old hardcoded cap (10) meant that on days when >10 cards were
 *   simultaneously due, the excess was quietly delayed by a full day,
 *   compounding drift against the intended interval. Making the default
 *   unlimited lets Ebbinghaus intervals do exactly what they promise.
 *
 * Why the cap exists at all:
 *   Some days the queue can spike (e.g. a batch of newly-added words all
 *   become due together). A user who wants a gentler daily ceiling can
 *   opt in via /settings.
 *
 * Persistence:
 *   Stored in localStorage under `get:preferences:v1` so the value survives
 *   reloads. The value is also mirrored to the cloud snapshot (see
 *   `lib/sync/cloud.ts`) so it follows the user across devices.
 *
 * Same-day change semantics:
 *   Changing `dailyCap` does NOT retroactively resize today's frozen
 *   snapshot — the snapshot in `daily-snapshot.ts` locks in whatever cap
 *   was current at the moment of the day's first read. New value applies
 *   from the next local day. This avoids the "progress bar jumps from
 *   7/10 to 7/20 mid-morning" jankiness.
 */

const STORAGE_KEY = "get:preferences:v1";

export interface Preferences {
  /** null = unlimited; otherwise a positive integer cap. */
  dailyCap: number | null;
}

const DEFAULTS: Preferences = {
  dailyCap: null,
};

/** Valid discrete choices offered in the UI. `null` is "unlimited". */
export const DAILY_CAP_CHOICES: Array<number | null> = [null, 10, 20, 30, 50];

function readRaw(): Preferences {
  if (typeof window === "undefined") return { ...DEFAULTS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      dailyCap:
        parsed.dailyCap === null
          ? null
          : typeof parsed.dailyCap === "number" && parsed.dailyCap > 0
            ? Math.floor(parsed.dailyCap)
            : DEFAULTS.dailyCap,
    };
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

export function getDailyCap(): number | null {
  return readRaw().dailyCap;
}

/**
 * Update the daily cap. Pass null for "unlimited". Fires a
 * `get:preferences-change` event so listeners can react.
 *
 * Note: today's already-frozen snapshot is intentionally NOT resized here.
 * See the module-level docblock for why.
 */
export function setDailyCap(cap: number | null): void {
  const prefs = readRaw();
  prefs.dailyCap = cap === null || cap === undefined ? null : Math.max(1, Math.floor(cap));
  writeRaw(prefs);
}

/**
 * Overwrite the entire preferences blob — used by the cloud sync layer
 * when a remote snapshot is pulled in. We take the remote value verbatim
 * (no timestamp-based merge) because preferences are small and the "last
 * device to change wins" model is what the user expects for a settings
 * page.
 */
export function replacePreferences(next: Partial<Preferences> | null | undefined): void {
  if (!next) return;
  const merged: Preferences = {
    ...readRaw(),
    ...(next.dailyCap !== undefined
      ? {
          dailyCap:
            next.dailyCap === null
              ? null
              : typeof next.dailyCap === "number" && next.dailyCap > 0
                ? Math.floor(next.dailyCap)
                : null,
        }
      : {}),
  };
  writeRaw(merged);
}
