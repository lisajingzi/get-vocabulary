/**
 * Cloud sync layer (skeleton).
 *
 * Day 5 ships the *interface* and a no-op implementation. When Supabase
 * credentials land (Day 3b/7), the same calls flip from local-only to
 * dual-write + reconcile-on-load with no UI changes.
 *
 * Sync model
 *   - Local writes happen first (latency-free UX).
 *   - When the Supabase client is available *and* the user is signed in,
 *     each mutation also fires a debounced upsert to Supabase.
 *   - On app boot, `pullRemote()` merges any remote rows into local using
 *     "last write wins" by `lastSeenAt`, which is good enough for a
 *     single-user product across 1–2 devices.
 *
 * Why this lives outside `wordbook/local.ts`:
 *   The local module stays a synchronous, dependency-free localStorage
 *   wrapper. Anything that touches the network goes through this thin
 *   adapter so the contract surface for tests stays small.
 */

import { listEntries, type WordbookEntry } from "@/lib/wordbook/local";

/** True when env vars are present AND we're in the browser (cookie auth). */
function isCloudEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return Boolean(url && anon);
}

/** Pull remote wordbook into local. No-op until cloud is enabled.
 *  Returns the number of entries reconciled. */
export async function pullRemote(): Promise<number> {
  if (!isCloudEnabled()) return 0;
  // Day 3b: actual SELECT + reconcile. We keep a stub so callers can already
  // mount the call site (e.g. on /wordbook focus) without conditional logic.
  return 0;
}

/** Upsert one entry. No-op until cloud is enabled. Idempotent. */
export async function pushEntry(_entry: WordbookEntry): Promise<void> {
  if (!isCloudEnabled()) return;
  void _entry;
  // Day 3b: actual upsert against `user_words` table.
}

/** Push the entire local store at once, e.g. on first login or recovery. */
export async function pushAll(): Promise<number> {
  if (!isCloudEnabled()) return 0;
  return listEntries().length; // pretend we pushed; real impl in Day 3b
}
