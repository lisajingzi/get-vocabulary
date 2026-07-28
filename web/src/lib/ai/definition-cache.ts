/**
 * AI definition popup cache.
 *
 * The wordbook "释义" button fetches /api/ai/definition and shows a small
 * popup with 1–2 English definitions + one example each. To keep the popup
 * feeling instant on repeat clicks (and to avoid burning tokens on every
 * open), we cache the response in IndexedDB keyed by lemma. First open
 * hits the network; every subsequent open just replays the cached payload.
 *
 * The user can trigger a fresh generation by clicking "再生成" in the
 * modal, which calls `saveDefinition` again to overwrite the entry.
 *
 * Note on `provider`/`mockReason`: these fields are legacy — kept optional
 * so older cached rows still parse. The current backend never writes them
 * (all-tier failures surface as a red error state in the UI instead of
 * a persisted mock payload).
 */

import { getAppDb, STORE_AI_DEFINITIONS } from "@/lib/db";

export interface DefinitionSense {
  def: string;
  example: { en: string; cn: string };
}

export interface AIDefinition {
  lemma: string;
  senses: DefinitionSense[];
  /** Legacy — older rows may still carry these. Not written by new code. */
  provider?: "deepseek" | "mock";
  mockReason?: string;
  cachedAt: string;
}

export async function getCachedDefinition(
  lemma: string,
): Promise<AIDefinition | null> {
  try {
    const db = await getAppDb();
    const row = (await db.get(STORE_AI_DEFINITIONS, lemma)) as
      | AIDefinition
      | undefined;
    return row ?? null;
  } catch {
    // IDB unavailable (private mode, quota, …) → treat as cache miss.
    return null;
  }
}

export async function saveDefinition(
  lemma: string,
  senses: DefinitionSense[],
): Promise<AIDefinition> {
  const payload: AIDefinition = {
    lemma,
    senses,
    cachedAt: new Date().toISOString(),
  };
  try {
    const db = await getAppDb();
    await db.put(STORE_AI_DEFINITIONS, payload, lemma);
  } catch {
    // Best effort — a failed persistence shouldn't break the UI.
  }
  return payload;
}
