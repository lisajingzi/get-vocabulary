/**
 * Client-side dictionary access layer.
 *
 * Architecture
 * ------------
 *  1. The Python ETL (`scripts/parse_mdx.py`) ships a sharded snapshot of the
 *     Oxford 9 mdx into `/dict/dictionary-{a..z|other}.json` (32 MB total).
 *  2. On first load the small `dictionary-index.json` (lemma → shard) and
 *     `lemma-list.json` (sorted lemma array) are fetched once and cached in
 *     memory + IndexedDB.
 *  3. Per-shard JSON files are loaded lazily on first lookup of any lemma in
 *     that shard. After fetch they're persisted into IndexedDB so the second
 *     visit is offline-capable and ~free.
 *
 * Why IndexedDB and not just an in-memory cache?
 *   - 32 MB across 27 shards. We want to survive page reloads without
 *     re-downloading them.
 *   - Service Worker caching would also work but is harder to reason about
 *     during V1 dev. IndexedDB is dead-simple and is also where user data
 *     lives offline (Day 3+).
 */

import {
  type DictAlias,
  type DictEntry,
  type DictRecord,
  isAlias,
} from "@/lib/types";
import { getAppDb, STORE_META, STORE_SHARD } from "@/lib/db";

/** Where the static JSON shards are served from (relative to web/public). */
const DICT_BASE = "/dict";

/**
 * Bump this whenever `scripts/parse_mdx.py` changes the on-disk shape.
 *
 *   1 → initial shape { lemma, senses, phon? }
 *   2 → adds `phrases?` (collocation frames extracted from <cf-blk>)
 *
 * A mismatch (or a value stored in the old, un-enveloped format) causes the
 * cached IDB copy to be discarded and re-fetched. We also append the schema
 * as a query string to the JSON URL so the *browser* HTTP cache doesn't
 * feed stale bytes back to us.
 */
const DICT_SCHEMA = 2;

interface Envelope<T> {
  schema: number;
  data: T;
}

function isCurrentEnvelope<T>(v: unknown): v is Envelope<T> {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Envelope<T>).schema === DICT_SCHEMA &&
    "data" in (v as Record<string, unknown>)
  );
}

// ---------------------------------------------------------------------------
// Index + lemma list (the "always-loaded" small files)
// ---------------------------------------------------------------------------

/** lemma → shard key (one of "a".."z","other"). */
type IndexMap = Record<string, string>;

/** In-memory caches (per page load) so repeated lookups don't even touch IDB. */
let indexCache: IndexMap | null = null;
let lemmaListCache: string[] | null = null;
const shardCache = new Map<string, Record<string, DictRecord>>();

/**
 * Ensure the dictionary index map is loaded. Resolves to the same object on
 * every call (memoised). Falls back to network if the IDB copy is missing.
 */
async function loadIndex(): Promise<IndexMap> {
  if (indexCache) return indexCache;
  const db = await getAppDb();
  const cached = await db.get(STORE_META, "index");
  if (isCurrentEnvelope<IndexMap>(cached)) {
    indexCache = cached.data;
    return cached.data;
  }
  const res = await fetch(
    `${DICT_BASE}/dictionary-index.json?v=${DICT_SCHEMA}`,
  );
  if (!res.ok) throw new Error(`failed to load dictionary index: ${res.status}`);
  const json = (await res.json()) as IndexMap;
  await db.put(
    STORE_META,
    { schema: DICT_SCHEMA, data: json } satisfies Envelope<IndexMap>,
    "index",
  );
  indexCache = json;
  return json;
}

/** Sorted lemma list (lowercase) for prefix-suggestion lookup. */
async function loadLemmaList(): Promise<string[]> {
  if (lemmaListCache) return lemmaListCache;
  const db = await getAppDb();
  const cached = await db.get(STORE_META, "lemmaList");
  if (isCurrentEnvelope<string[]>(cached)) {
    lemmaListCache = cached.data;
    return cached.data;
  }
  const res = await fetch(`${DICT_BASE}/lemma-list.json?v=${DICT_SCHEMA}`);
  if (!res.ok) throw new Error(`failed to load lemma list: ${res.status}`);
  const json = (await res.json()) as string[];
  await db.put(
    STORE_META,
    { schema: DICT_SCHEMA, data: json } satisfies Envelope<string[]>,
    "lemmaList",
  );
  lemmaListCache = json;
  return json;
}

/**
 * Load a shard ("a".."z","other") and return its lemma → record map.
 * Subsequent calls for the same shard skip the network entirely.
 *
 * Exported under an underscore-prefixed name because callers outside the
 * dict module shouldn't reach for shards directly — the synonym question
 * builder is the one privileged user that needs raw shard access.
 */
export async function _loadShard(
  shard: string,
): Promise<Record<string, DictRecord>> {
  const cached = shardCache.get(shard);
  if (cached) return cached;
  const db = await getAppDb();
  const stored = await db.get(STORE_SHARD, shard);
  type ShardData = Record<string, DictRecord>;
  if (isCurrentEnvelope<ShardData>(stored)) {
    shardCache.set(shard, stored.data);
    return stored.data;
  }
  const res = await fetch(
    `${DICT_BASE}/dictionary-${shard}.json?v=${DICT_SCHEMA}`,
  );
  if (!res.ok) throw new Error(`failed to load shard ${shard}: ${res.status}`);
  const json = (await res.json()) as ShardData;
  await db.put(
    STORE_SHARD,
    { schema: DICT_SCHEMA, data: json } satisfies Envelope<ShardData>,
    shard,
  );
  shardCache.set(shard, json);
  return json;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a lemma to its canonical entry, following one alias hop.
 * Returns null if the lemma isn't in the dictionary at all.
 *
 * The caller gets back BOTH the resolved entry AND the original lookup key
 * so the UI can show "abandoned → abandon" when a cross-ref was followed.
 */
export interface LookupResult {
  /** What the user asked for, lowercased + trimmed. */
  query: string;
  /** Canonical headword we ended up rendering. */
  lemma: string;
  /** Whether we followed an @@@LINK= alias. */
  redirected: boolean;
  /** The actual data the UI should render. */
  entry: DictEntry;
}

export async function lookup(rawQuery: string): Promise<LookupResult | null> {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return null;

  const index = await loadIndex();
  const directShard = index[query];
  if (!directShard) return null;

  const shard = await _loadShard(directShard);
  let rec = shard[query];
  if (!rec) return null;

  let redirected = false;
  let canonicalLemma = query;

  // Follow at most one alias hop. The Python parser already collapses chains,
  // so multi-hops shouldn't happen, but we guard against it anyway.
  if (isAlias(rec)) {
    const target = (rec as DictAlias).alias_of;
    const targetShardKey = index[target];
    if (!targetShardKey) return null;
    const targetShard = await _loadShard(targetShardKey);
    const targetRec = targetShard[target];
    if (!targetRec || isAlias(targetRec)) return null;
    rec = targetRec;
    canonicalLemma = target;
    redirected = true;
  }

  return {
    query,
    lemma: canonicalLemma,
    redirected,
    entry: rec as DictEntry,
  };
}

/**
 * Prefix-search the lemma list and return up to `limit` matches.
 *
 * Strategy: binary-search to the lower bound of the prefix, then walk forward
 * collecting hits until we hit `limit` or exit the prefix range. This is O(log n)
 * + O(limit) and fast enough at 195k entries to call on every keystroke.
 *
 * Behaviour decisions:
 *   - Single-word lemmas come first; multi-word phrases ("look forward to")
 *     fall to the end of the result list. This matches what users expect for
 *     English autosuggest.
 *   - Empty / whitespace-only input returns `[]` so callers can hide the menu.
 */
export async function suggest(
  prefix: string,
  limit = 8,
): Promise<string[]> {
  const p = prefix.trim().toLowerCase();
  if (!p) return [];
  const lemmas = await loadLemmaList();

  // Binary-search the start of the [p, p\uffff) range.
  let lo = 0;
  let hi = lemmas.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lemmas[mid] < p) lo = mid + 1;
    else hi = mid;
  }

  const singles: string[] = [];
  const phrases: string[] = [];
  for (let i = lo; i < lemmas.length; i++) {
    const lemma = lemmas[i];
    if (!lemma.startsWith(p)) break;
    if (/\s/.test(lemma)) {
      if (phrases.length < limit) phrases.push(lemma);
    } else {
      singles.push(lemma);
    }
    // stop early once we have plenty of candidates of either kind
    if (singles.length >= limit && phrases.length >= limit) break;
  }
  return [...singles, ...phrases].slice(0, limit);
}

/** Compute the shard key for an arbitrary lemma. Pure; no I/O. */
export function _shardOfLemma(lemma: string): string {
  const c = lemma[0]?.toLowerCase() ?? "";
  return c >= "a" && c <= "z" ? c : "other";
}

/** Test helper: clear all dictionary caches (memory + IDB). */
export async function _resetDictCache(): Promise<void> {
  indexCache = null;
  lemmaListCache = null;
  shardCache.clear();
  const db = await getAppDb();
  await db.clear(STORE_META);
  await db.clear(STORE_SHARD);
}
