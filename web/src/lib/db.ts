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
 *
 * Bump DB_VERSION whenever you add or rename a store; remember the upgrade
 * callback runs once per version step, so it must stay idempotent.
 */

import { openDB, type IDBPDatabase } from "idb";

export const DB_NAME = "get-dict";
export const DB_VERSION = 2;

export const STORE_META = "meta";
export const STORE_SHARD = "shards";
export const STORE_AI_EXAMPLES = "ai-examples";

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
      },
    });
  }
  return dbPromise;
}
