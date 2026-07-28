/**
 * AI example sentence cache.
 *
 * Per the product brief: "保留历史生成结果，下次直接调用，无需再次生成"。
 * So we keep an append-only log of every successful generation, keyed by
 * (lemma, senseIndex). The UI shows the most recent one by default and lets
 * the user flip back through the history.
 *
 * Storage: shared IndexedDB (lib/db.ts). On Day 5 / 7 we'll mirror this to
 * the `ai_examples` table for cross-device sync.
 */

import { getAppDb, STORE_AI_EXAMPLES } from "@/lib/db";

export interface AIExample {
  id: string;
  lemma: string;
  /** -1 = generated against the primary sense (no specific pick). */
  senseIndex: number;
  en: string;
  cn: string;
  highlights: string[];
  provider: "deepseek" | "mock";
  /** When provider="mock": upstream error string, if any.
   *  Missing on successful calls and on legacy entries stored before this
   *  field was introduced — treat undefined as "no context". */
  mockReason?: string;
  createdAt: string;
}

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** All cached generations for a (lemma, senseIndex) pair, newest first. */
export async function listExamples(
  lemma: string,
  senseIndex: number,
): Promise<AIExample[]> {
  const db = await getAppDb();
  const idx = db.transaction(STORE_AI_EXAMPLES).store.index("byLemma");
  const rows = (await idx.getAll([lemma, senseIndex])) as AIExample[];
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function addExample(
  data: Omit<AIExample, "id" | "createdAt">,
): Promise<AIExample> {
  const db = await getAppDb();
  const next: AIExample = {
    ...data,
    id: makeId(),
    createdAt: new Date().toISOString(),
  };
  await db.put(STORE_AI_EXAMPLES, next);
  return next;
}

export async function deleteExample(id: string): Promise<void> {
  const db = await getAppDb();
  await db.delete(STORE_AI_EXAMPLES, id);
}
