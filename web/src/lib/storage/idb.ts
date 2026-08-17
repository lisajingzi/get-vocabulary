/**
 * Minimal IndexedDB key/value wrapper.
 *
 * Purpose:
 *   Notes (both wordbook notes and notebook notes) can grow past the
 *   ~2-5 MB localStorage quota that mobile browsers (especially WeChat
 *   WebView) enforce, mostly because users attach base64 images. On
 *   phones this manifests as `QuotaExceededError` on setItem and the
 *   remote-sync layer refusing to write locally.
 *
 *   IndexedDB has a much larger quota (hundreds of MB to several GB
 *   depending on free disk space) and is the correct home for these
 *   payloads. We keep the API surface tiny: get / set / remove / keys.
 *
 * Design notes:
 *   - One database ("get-vocabulary") with one object store ("kv").
 *   - Keys are strings, values are arbitrary structured-clonable data.
 *     We deliberately do NOT JSON.stringify — IndexedDB accepts raw
 *     objects, and skipping the round-trip halves memory pressure on
 *     large payloads.
 *   - All calls resolve to `null` if IndexedDB is unavailable (SSR,
 *     private mode on very old iOS, disabled by user). Callers should
 *     treat that as "no cached value" and fall back to defaults.
 *   - Errors during writes are surfaced (rejected promise) so callers
 *     can log / retry. Errors during reads resolve to null so a
 *     one-off corrupt row can't wedge the whole app.
 */

const DB_NAME = "get-vocabulary";
const DB_VERSION = 1;
const STORE_NAME = "kv";

// Lazily-opened DB connection, shared across calls. We open exactly once
// per page load; the browser will queue transactions internally.
let dbPromise: Promise<IDBDatabase | null> | null = null;

function isAvailable(): boolean {
  return typeof window !== "undefined" && "indexedDB" in window;
}

function openDb(): Promise<IDBDatabase | null> {
  if (!isAvailable()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = window.indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      console.error("[idb] open threw:", e);
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.error("[idb] open failed:", req.error);
      // Reset so a later call can retry — the failure may have been transient
      // (e.g. Safari private mode temporarily denying access).
      dbPromise = null;
      resolve(null);
    };
    req.onblocked = () => {
      console.warn("[idb] open blocked by another tab");
      resolve(null);
    };
  });
  return dbPromise;
}

/**
 * Read a value by key. Returns null on miss OR on any error.
 * Callers should treat null as "no cached value" and use their own default.
 */
export async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise<T | null>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_NAME, "readonly");
    } catch (e) {
      console.error("[idb] tx open failed on get", key, e);
      resolve(null);
      return;
    }
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => {
      console.error("[idb] get failed", key, req.error);
      resolve(null);
    };
  });
}

/**
 * Write a value. Rejects on failure — callers should log and can retry.
 * Unlike localStorage.setItem, IndexedDB write errors here mean something
 * is genuinely wrong (disk full, quota, DB corrupt) and shouldn't be
 * silently swallowed.
 */
export async function idbSet<T>(key: string, value: T): Promise<void> {
  const db = await openDb();
  if (!db) {
    // Persistence layer unavailable. We still consider the "write" to have
    // succeeded logically (in-memory cache is the source of truth for the
    // session); the reject would be noisy and unactionable.
    return;
  }
  return new Promise<void>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_NAME, "readwrite");
    } catch (e) {
      reject(e);
      return;
    }
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(value, key);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Delete a key. Silent on missing keys (that's the desired outcome).
 */
export async function idbRemove(key: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise<void>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_NAME, "readwrite");
    } catch (e) {
      reject(e);
      return;
    }
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(key);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
  });
}

/**
 * Whether IndexedDB is available in this environment. Callers can use
 * this to decide whether to fall back to localStorage-only behavior.
 */
export function idbAvailable(): boolean {
  return isAvailable();
}
