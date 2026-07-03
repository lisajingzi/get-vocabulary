/**
 * Single shared IndexedDB handle for the whole app.
 *
 * Why one DB instead of one per feature:
 *   - IndexedDB versioning is per-database. If the dict layer opens v1 and the
 *     AI cache opens v2 on the same DB name, they fight over schema upgrades.
 *   - Bundle size: one openDB call, one schema migration switch, one place to
 *     reason about offline behaviour.
 *
 * Stores
 *   meta          dictionary index + lemma list (key/value blobs)
 *   shards        dictionary shard payloads (key = shard letter)
 *   ai-examples   AI-generated example sentence history (keyPath = id)
 *   tts-cache     Cached MP3 blobs from /api/tts, keyed by "<voice>|<text>"
 *                 so the second click on the same sentence is instant and
 *                 doesn't re-hit the network.
 *   syn-shards    Offline near-synonym table shards (key = "a".."z"|"other").
 *                 Value = { lemma → { pos → string[] } }.
 *   syn-ai        AI-fallback synonyms for lemmas absent from syn-shards
 *                 (key = lemma, value = { pos → string[] }). Fetched at most
 *                 once per lemma; the mock provider result is also cached
 *                 (harmless; we just retry next session if it was empty).
 *
 * Bump DB_VERSION whenever you add or rename a store; remember the upgrade
 * callback runs once per version step, so it must stay idempotent.
 */

import { openDB, type IDBPDatabase } from "idb";

export const DB_NAME = "get-dict";
export const DB_VERSION = 4;

export const STORE_META = "meta";
export const STORE_SHARD = "shards";
export const STORE_AI_EXAMPLES = "ai-examples";
export const STORE_TTS_CACHE = "tts-cache";
export const STORE_SYN_SHARD = "syn-shards";
export const STORE_SYN_AI = "syn-ai";

let dbPromise: Promise<IDBPDatabase> | null = null;

export function getAppDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META);
        }
        if (!db.objectStoreNames.contains(STORE_SHARD)) {
          db.createObjectStore(STORE_SHARD);
        }
        if (!db.objectStoreNames.contains(STORE_AI_EXAMPLES)) {
          const store = db.createObjectStore(STORE_AI_EXAMPLES, {
            keyPath: "id",
          });
          store.createIndex("byLemma", ["lemma", "senseIndex"]);
        }
        if (!db.objectStoreNames.contains(STORE_TTS_CACHE)) {
          // Value = ArrayBuffer (MP3 bytes). Key = "<voice>|<text>".
          db.createObjectStore(STORE_TTS_CACHE);
        }
        if (!db.objectStoreNames.contains(STORE_SYN_SHARD)) {
          // Value = { lemma → { pos → string[] } }. Key = shard letter.
          db.createObjectStore(STORE_SYN_SHARD);
        }
        if (!db.objectStoreNames.contains(STORE_SYN_AI)) {
          // Value = { pos → string[] }. Key = target lemma.
          db.createObjectStore(STORE_SYN_AI);
        }
      },
    });
  }
  return dbPromise;
}
