/**
 * AI definition popup cache.
 *
 * The wordbook "释义" button fetches /api/ai/definition and shows a small
 * popup with 1–2 English definitions + one example each. To keep the popup
 * feeling instant on repeat clicks (and to avoid burning DeepSeek tokens on
 * every open), we cache the response in IndexedDB keyed by lemma. First
 * open hits the network, every subsequent open just replays the cached
 * payload.
 *
 * The user can trigger a fresh generation by clicking "再生成" in the
 * modal, which calls `saveDefinition` again to overwrite the entry.
 */

import { getAppDb, STORE_AI_DEFINITIONS } from "@/lib/db";

export interface DefinitionSense {
  def: string;
  example: { en: string; cn: string };
}

export interface AIDefinition {
  lemma: string;
  senses: DefinitionSense[];
  provider: "deepseek" | "mock";
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
  provider: "deepseek" | "mock",
): Promise<AIDefinition> {
  const payload: AIDefinition = {
    lemma,
    senses,
    provider,
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
