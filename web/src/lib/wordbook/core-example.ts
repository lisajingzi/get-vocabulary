/**
 * Helper for picking a "core example" (short representative sentence or
 * phrase) from a dictionary entry to seed `WordbookEntry.coreExample`.
 *
 * Priority (v2 — per product spec, "从释义里挑，不用常用搭配区")：
 *   1. First sense whose `ex[0]` has usable English (walks all senses).
 *      Chinese translation is appended after " — " when available so the
 *      wordbook list can strip it back off client-side (`stripChinese`).
 *   2. Fall back to first sense's Chinese gloss (chn).
 *   3. Fall back to first sense's English def.
 *
 * Note: we intentionally do NOT use `entry.phrases[*]` — that block is
 * the Oxford 9 "common collocation" strip (<cf-blk>), which produces
 * unhelpful skeletons like "abandon a pursuit" that don't sound like
 * real sentences. The user asked for释义里的短语或句子, which means
 * `senses[*].ex[*]`.
 */

import { lookup } from "@/lib/dict";
import {
  backfillCoreExample,
  listEntries,
  refillCoreExampleIfDefault,
} from "@/lib/wordbook/local";
import type { DictEntry, DictSense } from "@/lib/types";

/** v2 migration flag — bumped when the pick-priority changes so we can
 *  re-derive defaults for entries that haven't been manually edited. */
const MIGRATION_FLAG_KEY = "get:core-example:migration:v2";

/**
 * Compute a default coreExample string from a fully-loaded dictionary entry.
 * Priority: first sense-example > first sense chn/def gloss.
 */
export function pickDefaultCoreExample(senses: DictSense[]): string {
  // Walk senses in order and grab the first one that carries a usable
  // English example. This handles the case where sense #0 has no examples
  // but sense #1 does (common on shorter entries).
  for (const s of senses ?? []) {
    const ex = s.ex?.[0];
    if (ex?.en) return ex.cn ? `${ex.en} — ${ex.cn}` : ex.en;
  }
  // Fall back to the first sense's gloss — rare but keeps the field non-empty
  // for entries where the dictionary omits examples entirely.
  const s0 = senses?.[0];
  if (s0?.chn) return s0.chn;
  if (s0?.def) return s0.def;
  return "";
}

/**
 * Same as pickDefaultCoreExample but takes a full DictEntry.
 */
export function coreExampleFromEntry(entry: DictEntry): string {
  return pickDefaultCoreExample(entry.senses);
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
 * One-shot migration:
 *   1. First pass — fill entries missing a coreExample entirely
 *      (`backfillCoreExample`, idempotent).
 *   2. v2 pass — one-time refill of entries that were seeded by the
 *      OLD priority (phrase-first) but haven't been manually edited.
 *      Guarded by a localStorage flag so it only runs once per device.
 *
 * Safe to call on every app boot. Rate-limits itself so a fresh device
 * with 3000 unmigrated words doesn't fire 3000 concurrent shard-load
 * requests at once.
 */
let migrationInFlight: Promise<void> | null = null;
export function migrateCoreExamples(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (migrationInFlight) return migrationInFlight;
  migrationInFlight = (async () => {
    const allEntries = listEntries({ includeArchived: true });
    // 1. Backfill entries missing coreExample entirely.
    const missing = allEntries.filter(
      (e) => !e.coreExample || e.coreExample.trim().length === 0,
    );
    for (let i = 0; i < missing.length; i++) {
      const entry = missing[i];
      const text = await resolveDefaultCoreExample(entry.lemma);
      if (text) backfillCoreExample(entry.lemma, text);
      if ((i + 1) % 50 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    // 2. v2 refill — one-time per device. Walk every entry that hasn't
    //    been manually edited and re-derive using the new priority.
    //    refillCoreExampleIfDefault() is a no-op if the value already
    //    matches or the user has an override, so this is safe and cheap.
    let v2Done = false;
    try {
      v2Done = window.localStorage.getItem(MIGRATION_FLAG_KEY) === "1";
    } catch {
      /* ignore */
    }
    if (!v2Done) {
      const candidates = listEntries({ includeArchived: true }).filter(
        (e) => !e.coreExampleEditedAt,
      );
      for (let i = 0; i < candidates.length; i++) {
        const entry = candidates[i];
        const text = await resolveDefaultCoreExample(entry.lemma);
        if (text) refillCoreExampleIfDefault(entry.lemma, text);
        if ((i + 1) % 50 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      try {
        window.localStorage.setItem(MIGRATION_FLAG_KEY, "1");
      } catch {
        /* ignore */
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
