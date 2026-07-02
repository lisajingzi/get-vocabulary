/**
 * Client-side cache for /api/tts MP3 payloads.
 *
 * Rationale
 * ---------
 * Neural TTS is *the* slow leg of "click speaker → hear voice" (~1-2s cold).
 * Since the same (voice, text) always yields byte-identical audio, we stash
 * the MP3 in IndexedDB the first time we get it. Subsequent clicks resolve
 * against the cache instantly and work offline.
 *
 * Storage note: object stores can hold ArrayBuffer directly, but Blob works
 * too and is what `<audio>` really wants. We write ArrayBuffer for maximum
 * portability and wrap it in a Blob at read time.
 */

import { getAppDb, STORE_TTS_CACHE } from "@/lib/db";

/** Compose the composite cache key. Trimmed & lower-cased for stability. */
export function ttsCacheKey(voice: string, text: string): string {
  return `${voice}|${text.trim()}`;
}

/** Returns a Blob URL for the cached MP3, or null if not cached. */
export async function getCachedTTS(
  voice: string,
  text: string,
): Promise<Blob | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await getAppDb();
    const buf = (await db.get(STORE_TTS_CACHE, ttsCacheKey(voice, text))) as
      | ArrayBuffer
      | undefined;
    if (!buf) return null;
    return new Blob([buf], { type: "audio/mpeg" });
  } catch {
    return null;
  }
}

/** Persist an MP3 payload for later reuse. Silent on failure. */
export async function putCachedTTS(
  voice: string,
  text: string,
  bytes: ArrayBuffer,
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await getAppDb();
    await db.put(STORE_TTS_CACHE, bytes, ttsCacheKey(voice, text));
  } catch {
    /* cache is a best-effort optimisation; ignore quota / etc. errors */
  }
}
