/**
 * Synonym question generator for the review quiz.
 *
 * Design (offline-only):
 *   1. CORRECT ANSWER comes from the offline WordNet-derived table
 *      `/dict/synonyms-{shard}.json` (built by scripts/build_synonyms.py).
 *      Every candidate must also exist in the OALD dict so the UI can
 *      render its Chinese gloss on the answer-explanation panel.
 *   2. If the offline table has no usable synonym for the target lemma
 *      (the target is a concrete noun with no true single-word synonym,
 *      or WordNet's coverage is thin for adjectives, etc.) we return
 *      null. The caller (<ReviewView />) then falls back to a spelling
 *      question rather than showing dubious "synonyms" like the previous
 *      AI-fallback path did — better to test spelling than to teach the
 *      user a wrong semantic association.
 *   3. DISTRACTORS come from the same dict shard as the target, biased
 *      toward same-POS + visually similar (first/last letter, length,
 *      shared prefix). Never pulled from the user's own wordbook.
 *
 * Everything runs in the browser against cached IDB data — no network.
 */

import { lookup, _loadShard, _shardOfLemma } from "@/lib/dict";
import type { DictEntry } from "@/lib/types";
import { getAppDb, STORE_SYN_SHARD } from "@/lib/db";

// ---------------------------------------------------------------------------
// POS normalisation
// ---------------------------------------------------------------------------

/** Compact POS tag as stored in synonyms-*.json. */
type PosShort = "n" | "v" | "adj" | "adv";

/** Map an OALD `senses[i].pos` string to our short tag. Returns null for
 *  parts of speech we don't ship synonyms for (prep / pron / conj / …). */
function posToShort(pos: string | undefined): PosShort | null {
  if (!pos) return null;
  const p = pos.toLowerCase();
  if (p.startsWith("noun")) return "n";
  if (p.startsWith("verb")) return "v";
  if (p.startsWith("adj")) return "adj";
  if (p.startsWith("adv")) return "adv";
  return null;
}

// ---------------------------------------------------------------------------
// Synonym-shard loading (lazy + IDB-cached)
// ---------------------------------------------------------------------------

type SynShard = Record<string, Partial<Record<PosShort, string[]>>>;

const synShardCache = new Map<string, SynShard>();
/** Shard letters that returned 404 during dev, so we don't hammer the network. */
const missingSynShards = new Set<string>();

async function loadSynShard(shard: string): Promise<SynShard | null> {
  if (missingSynShards.has(shard)) return null;
  const cached = synShardCache.get(shard);
  if (cached) return cached;
  const db = await getAppDb();
  const stored = (await db.get(STORE_SYN_SHARD, shard)) as SynShard | undefined;
  if (stored) {
    synShardCache.set(shard, stored);
    return stored;
  }
  try {
    const res = await fetch(`/dict/synonyms-${shard}.json`);
    if (!res.ok) {
      missingSynShards.add(shard);
      return null;
    }
    const json = (await res.json()) as SynShard;
    await db.put(STORE_SYN_SHARD, json, shard);
    synShardCache.set(shard, json);
    return json;
  } catch {
    missingSynShards.add(shard);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Distractor scoring — visually similar, same POS, not a synonym
// ---------------------------------------------------------------------------

function firstLetter(s: string): string {
  return s[0]?.toLowerCase() ?? "";
}
function lastLetter(s: string): string {
  return s[s.length - 1]?.toLowerCase() ?? "";
}

/**
 * Score a candidate distractor against the target: higher = better distractor
 * (more visually / lexically similar to the target lemma). Anything scoring 0
 * is dropped — we don't want random filler.
 */
function distractorScore(target: string, cand: string): number {
  if (target === cand) return 0;
  const dLen = Math.abs(target.length - cand.length);
  if (dLen > 3) return 0;
  let s = 0;
  if (firstLetter(target) === firstLetter(cand)) s += 3;
  if (lastLetter(target) === lastLetter(cand)) s += 2;
  if (dLen === 0) s += 2;
  else if (dLen === 1) s += 1;
  // Prefix / suffix overlap of length ≥3 (e.g. "abandon" ↔ "abandoned").
  const shared = commonPrefix(target, cand);
  if (shared >= 3) s += shared;
  return s;
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Pick the sense whose POS matches `wantPos` (short tag). Falls back to the
 * primary sense if no match exists. This matters when e.g. WordNet lists
 * `fleet` as an adj-synonym of `swift`, but the OALD dict's `fleet` entry
 * has "noun: 舰队" as senses[0] and the adj sense buried later — showing
 * "舰队" would be misleading.
 */
function pickSenseByPos<T extends { pos?: string }>(
  senses: T[],
  wantPos: PosShort | null,
): T | null {
  if (!senses.length) return null;
  if (wantPos) {
    const hit = senses.find((s) => posToShort(s.pos) === wantPos);
    if (hit) return hit;
  }
  return senses[0];
}

// ---------------------------------------------------------------------------
// Public types (unchanged shape — ReviewView keeps working as-is)
// ---------------------------------------------------------------------------

export interface ChoiceGloss {
  pos?: string;
  def?: string;
  chn?: string;
}

export interface SynonymQuestion {
  target: string;
  prompt: { def?: string; chn?: string; pos?: string };
  choices: string[];
  answerIndex: number;
  glossMap: Record<string, ChoiceGloss>;
  /** Kept for API compatibility with the old Chinese-token overlap heuristic;
   *  the new implementation just leaves this empty. The explanation panel
   *  gracefully hides the "shared tokens" hint when it's empty. */
  sharedTokens: string[];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function buildSynonymQuestion(
  targetLemma: string,
): Promise<SynonymQuestion | null> {
  const target = targetLemma.toLowerCase();
  const targetLookup = await lookup(target);
  if (!targetLookup) return null;
  // Skip inflected/derived forms — the dict senses belong to the base lemma
  // so the POS/gloss we'd surface is misleading.
  if (targetLookup.redirected) return null;
  const targetEntry = targetLookup.entry;
  const primary = targetEntry.senses[0];
  if (!primary) return null;
  const targetPos = posToShort(primary.pos);

  // ---- 1. Correct answer + full synonym set ---------------------------
  const shardKey = _shardOfLemma(target);
  const synShard = await loadSynShard(shardKey);
  const offlineSyns: Partial<Record<PosShort, string[]>> =
    synShard?.[target] ?? {};

  // Prefer the primary POS; fall back to whatever POS has synonyms.
  let usedPos: PosShort | null = null;
  let synList: string[] = [];
  if (targetPos && offlineSyns[targetPos]?.length) {
    usedPos = targetPos;
    synList = offlineSyns[targetPos]!;
  } else {
    for (const p of ["n", "v", "adj", "adv"] as const) {
      if (offlineSyns[p]?.length) {
        usedPos = p;
        synList = offlineSyns[p]!;
        break;
      }
    }
  }

  // No offline synonyms → give up. ReviewView will fall back to spelling.
  if (synList.length === 0) return null;

  // The full "don't offer as a distractor" set = every synonym across every
  // POS in the offline entry.
  const forbid = new Set<string>([target]);
  for (const p of ["n", "v", "adj", "adv"] as const) {
    for (const s of offlineSyns[p] ?? []) forbid.add(s);
  }

  // ---- 2. Load dict shard once and pick a viable correct answer -------
  const dictShard = await _loadShard(shardKey);
  // For distractor selection we may need OTHER shards too (if the target's
  // shard is thin — e.g. 'x' or 'z'). Load lazily on demand.
  const loadedDictShards = new Map<string, Record<string, unknown>>();
  loadedDictShards.set(shardKey, dictShard);

  // Pick the FIRST synonym that resolves in the dict AND has a sense in the
  // POS we're testing. Prefer a POS-matched sense so the gloss shown next to
  // the correct answer actually corresponds to why it's a synonym (e.g.
  // `fleet` as an adjective for `swift`, not the "舰队" noun sense).
  let correctLemma: string | null = null;
  let correctSense: DictEntry["senses"][number] | null = null;
  for (const cand of synList) {
    const got = await lookup(cand);
    if (!got || got.redirected) continue;
    const s = pickSenseByPos(got.entry.senses, usedPos);
    if (!s) continue;
    // If we have a POS to match and this candidate genuinely has no sense
    // for that POS, skip it — otherwise we'd surface a mismatched gloss.
    if (usedPos && posToShort(s.pos) !== usedPos) continue;
    correctLemma = got.lemma;
    correctSense = s;
    break;
  }
  // Last-resort: if no candidate had a POS-matched sense, accept the first
  // dict-resolvable one so the quiz still fires (better than null).
  if (!correctLemma) {
    for (const cand of synList) {
      const got = await lookup(cand);
      if (!got || got.redirected) continue;
      const s = got.entry.senses[0];
      if (!s) continue;
      correctLemma = got.lemma;
      correctSense = s;
      break;
    }
  }
  if (!correctLemma || !correctSense) return null;
  forbid.add(correctLemma);

  // ---- 3. Build distractor pool ---------------------------------------
  const scored: Array<{
    lemma: string;
    score: number;
    sense: DictEntry["senses"][number];
  }> = [];

  const scanShard = (shard: Record<string, unknown>) => {
    for (const [lemma, rec] of Object.entries(shard)) {
      if (forbid.has(lemma)) continue;
      // No hyphenated / space-y / sub-lemma forms as distractors.
      if (!/^[a-z]{2,}$/.test(lemma)) continue;
      if (rec && typeof rec === "object" && "alias_of" in (rec as object)) continue;
      const entry = rec as DictEntry;
      // Same-POS filter (only when we know the target POS): prefer a sense
      // that matches so the gloss the user reads actually reflects why the
      // word is a plausible-but-wrong option.
      const sense = pickSenseByPos(entry.senses ?? [], usedPos);
      if (!sense) continue;
      if (usedPos && posToShort(sense.pos) !== usedPos) continue;
      const score = distractorScore(target, lemma);
      if (score > 0) scored.push({ lemma, score, sense });
    }
  };

  scanShard(dictShard as Record<string, unknown>);

  // If the same-shard pool is thin (rare — happens for 'x' / 'z'), broaden to
  // a couple of neighbouring shards, keeping the same POS + similarity guard.
  if (scored.length < 8) {
    for (const other of ["a", "e", "s", "t", "r"] as const) {
      if (scored.length >= 12) break;
      if (other === shardKey) continue;
      if (loadedDictShards.has(other)) continue;
      const s = (await _loadShard(other)) as Record<string, unknown>;
      loadedDictShards.set(other, s);
      scanShard(s);
    }
  }

  if (scored.length < 3) return null;

  // Sort by descending score; break ties randomly so we don't always show
  // the same 3 words for the same target.
  scored.sort((a, b) => b.score - a.score || Math.random() - 0.5);

  // Take the top-15 and pick 3 at random for variety across attempts.
  const top = scored.slice(0, 15);
  for (let i = top.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [top[i], top[j]] = [top[j], top[i]];
  }
  const distractors = top.slice(0, 3);
  if (distractors.length < 3) return null;

  // ---- 4. Assemble the final 4-choice question ------------------------
  const all = [
    { lemma: correctLemma, sense: correctSense },
    ...distractors.map((d) => ({ lemma: d.lemma, sense: d.sense })),
  ];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const answerIndex = all.findIndex((c) => c.lemma === correctLemma);

  const glossMap: Record<string, ChoiceGloss> = {};
  for (const c of all) {
    glossMap[c.lemma] = {
      pos: c.sense.pos,
      def: c.sense.def,
      chn: c.sense.chn,
    };
  }

  return {
    target,
    prompt: { def: primary.def, chn: primary.chn, pos: primary.pos },
    choices: all.map((c) => c.lemma),
    answerIndex,
    glossMap,
    sharedTokens: [],
  };
}
