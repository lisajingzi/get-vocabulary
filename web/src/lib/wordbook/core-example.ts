/**
 * Helper for picking a "core example" (short representative sentence or
 * phrase) from a dictionary entry to seed `WordbookEntry.coreExample`.
 *
 * Priority order (per product spec, phrases > examples):
 *   1. First phrase's example ("phrases[0].example.en") — usually a
 *      collocation phrase, most likely to help memorization.
 *   2. First phrase's `filled` pattern (bare structural phrase).
 *   3. First sense's first example ("senses[0].ex[0]"), preferring English.
 *   4. First sense's Chinese definition or English definition (last resort).
 *
 * Returns an empty string when the dictionary shows no usable material —
 * caller should leave `coreExample` unset in that case.
 */

import { lookup } from "@/lib/dict";
import { backfillCoreExample, listEntries } from "@/lib/wordbook/local";
import type { DictEntry, DictPhrase, DictSense } from "@/lib/types";

/**
 * Compute a default coreExample string from a fully-loaded dictionary entry.
 * Priority: phrase example > phrase filled pattern > sense example > gloss.
 */
export function pickDefaultCoreExample(
  senses: DictSense[],
  phrases: DictPhrase[] | undefined,
): string {
  // 1. phrase example
  const phEx = phrases?.[0]?.example;
  if (phEx?.en) return phEx.cn ? `${phEx.en} — ${phEx.cn}` : phEx.en;
  // 2. phrase filled
  const phFilled = phrases?.[0]?.filled;
  if (phFilled) return phFilled;
  // 3. sense example
  const ex = senses?.[0]?.ex?.[0];
  if (ex?.en) return ex.cn ? `${ex.en} — ${ex.cn}` : ex.en;
  // 4. gloss fallback
  const s = senses?.[0];
  if (s?.chn) return s.chn;
  if (s?.def) return s.def;
  return "";
}

/**
 * Same as pickDefaultCoreExample but takes a full DictEntry.
 */
export function coreExampleFromEntry(entry: DictEntry): string {
  return pickDefaultCoreExample(entry.senses, entry.phrases);
}

/**
 * Async lookup + pick. Returns "" if the dictionary has no entry.
 */
export async function resolveDefaultCoreExample(
  lemma: string,
): Promise<string> {
  try {
    const got = await lookup(lemma);
    if (!got) return "";
    return coreExampleFromEntry(got.entry);
  } catch {
    return "";
  }
}

/**
 * One-shot migration: scan all wordbook entries and, for anyone missing a
 * coreExample, fetch the dictionary and backfill. Idempotent and can be
 * called on every app boot (it early-exits on entries that already have
 * a value). Skips entries whose dictionary lookup fails.
 *
 * We chunk the awaits so a fresh device with 3000 unmigrated words doesn't
 * fire 3000 concurrent shard-load requests at once.
 */
let migrationInFlight: Promise<void> | null = null;
export function migrateCoreExamples(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (migrationInFlight) return migrationInFlight;
  migrationInFlight = (async () => {
    const entries = listEntries({ includeArchived: true });
    const missing = entries.filter(
      (e) => !e.coreExample || e.coreExample.trim().length === 0,
    );
    if (missing.length === 0) return;
    // Run sequentially — each lookup() call hits shard cache after the
    // first fetch per letter, so sequential is fine and gentle on the
    // network. We yield every 50 entries so the UI stays responsive.
    for (let i = 0; i < missing.length; i++) {
      const entry = missing[i];
      const text = await resolveDefaultCoreExample(entry.lemma);
      if (text) backfillCoreExample(entry.lemma, text);
      if ((i + 1) % 50 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  })();
  migrationInFlight
    .catch((e) => console.warn("[coreExample migration] failed:", e))
    .finally(() => {
      migrationInFlight = null;
    });
  return migrationInFlight;
}
