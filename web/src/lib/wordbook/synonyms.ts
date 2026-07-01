/**
 * Synonym candidate sourcing for the review quiz (4-choice).
 *
 * The goal isn't to be a real thesaurus — it's to surface 3 *plausible
 * distractors* + 1 correct answer for a given target lemma, so the user
 * has to actually read the definition to pick.
 *
 * Strategy (no external thesaurus dependency):
 *   1. Take the target's Chinese gloss(es) for its primary sense.
 *   2. Tokenise into Chinese keywords (drop punctuation + 1-char fillers).
 *   3. Walk the same-letter shard of the dictionary, score every other lemma
 *      by how many of those keywords appear in its own glosses (at least 1
 *      keyword shared, same part of speech preferred).
 *   4. Top-scoring lemma = the "correct" near-synonym; next 3 lemmas with
 *      ≥1 keyword overlap are the distractors.
 *   5. If we can't find enough hits in the same shard, fall back to scanning
 *      the user's own wordbook (still better than random English filler).
 *
 * This runs entirely in the browser against the cached dictionary shards.
 * It's not free (a full shard scan is O(N) where N ≈ 5–20k), but it only
 * fires once per review item and the data is already in IndexedDB / memory.
 */

import { lookup, _loadShard, _shardOfLemma } from "@/lib/dict";
import type { DictEntry } from "@/lib/types";
import { getKnownLemmaSet } from "@/lib/wordbook/local";

/** Coarse Chinese stopword list — drop these from gloss tokens. */
const ZH_STOP = new Set([
  "的",
  "了",
  "和",
  "或",
  "等",
  "是",
  "在",
  "有",
  "对",
  "把",
  "及",
  "与",
  "中",
  "上",
  "下",
  "之",
  "其",
  "某",
  "某人",
  "某事",
  "某物",
  "某种",
  "做",
  "使",
  "让",
  "被",
  "向",
  "从",
  "为",
  "以",
  "给",
  "一",
  "二",
  "三",
  "个",
  "用",
  "经",
  "已",
  "便",
  "可",
  "要",
  "会",
  "能",
  "得",
  "起",
  "出",
  "进",
  "去",
  "来",
  "到",
  "过",
  "如",
  "使得",
  "因",
  "若",
  "都",
  "也",
  "再",
  "又",
  "便是",
]);

function chineseTokens(gloss: string): string[] {
  // Strip parentheticals "（…）" and English/punctuation noise; keep CJK runs.
  const cleaned = gloss
    .replace(/[（(].*?[)）]/g, " ")
    .replace(/[\u3000-\u303F\uFF00-\uFFEF]/g, " ")
    .replace(/[^\u4e00-\u9fff]/g, " ");
  // Use 1- and 2-char sliding windows; CJK words in OALD glosses are usually
  // 2 chars (e.g. 离弃 / 抛弃). 1-char windows alone are too noisy to score on.
  const out = new Set<string>();
  for (const run of cleaned.split(/\s+/)) {
    if (!run) continue;
    for (let i = 0; i < run.length - 1; i++) {
      const tok = run.slice(i, i + 2);
      if (!ZH_STOP.has(tok) && !ZH_STOP.has(tok[0]) && !ZH_STOP.has(tok[1])) {
        out.add(tok);
      }
    }
  }
  return Array.from(out);
}

interface CandidateBucket {
  lemma: string;
  pos: string;
  score: number;
  chn: string;
}

/**
 * Build a 4-option synonym question for `targetLemma`.
 *
 * Returns the four lemmas (the correct answer + 3 distractors) and which
 * index is correct. The order is shuffled so the UI can render directly.
 *
 * If we genuinely can't source 4 lemmas (very small dictionary cache yet,
 * or weird lemma), returns null and the caller should fall back to a
 * different review style (e.g. spelling).
 */
export interface ChoiceGloss {
  pos?: string;
  def?: string;
  chn?: string;
}

export interface SynonymQuestion {
  target: string;
  /** Definition / gloss shown above the choices to ground the user. */
  prompt: { def?: string; chn?: string; pos?: string };
  /** 4 lemmas to render as choices. */
  choices: string[];
  /** Index in `choices` that is the "correct" near-synonym. */
  answerIndex: number;
  /** Per-choice gloss, keyed by lemma. Populated for ALL 4 choices so the
   *  answer-explanation panel can show "what each option meant" without
   *  re-fetching the dictionary. */
  glossMap: Record<string, ChoiceGloss>;
  /** Tokens (中文 2-char) that target & correct answer share — used to
   *  surface "why these two are similar" in the explanation panel. */
  sharedTokens: string[];
}

export async function buildSynonymQuestion(
  targetLemma: string,
): Promise<SynonymQuestion | null> {
  const target = targetLemma.toLowerCase();
  const targetLookup = await lookup(target);
  if (!targetLookup) return null;
  // If the user's lemma is a derived/inflected form (e.g. "arousal" → "arouse"),
  // the dict's `senses` belong to the BASE lemma, not the user's word. Using
  // `senses[0]` here would surface the wrong part of speech AND the wrong
  // gloss (verb "激起" instead of noun "激起、唤醒"). Skip the synonym quiz
  // entirely in that case — ReviewView falls back to a compose-only flow.
  if (targetLookup.redirected) return null;
  const targetEntry = targetLookup.entry;
  const primary = targetEntry.senses[0];
  if (!primary) return null;

  const targetTokens = new Set(chineseTokens(primary.chn ?? ""));
  if (targetTokens.size === 0) return null;

  // Pull all entries from the same shard for pos-and-gloss scoring.
  const shardKey = _shardOfLemma(target);
  const shardEntries = await _loadShard(shardKey);

  const candidates: CandidateBucket[] = [];
  // Also remember each candidate's English def so the explanation panel can
  // show "错选词是什么意思" without a second dict lookup.
  const defByLemma = new Map<string, string | undefined>();
  for (const [lemma, rec] of Object.entries(shardEntries)) {
    if (lemma === target) continue;
    if ("alias_of" in rec) continue;
    const e = rec as DictEntry;
    const sense = e.senses[0];
    if (!sense?.chn) continue;
    if (sense.pos && primary.pos && sense.pos !== primary.pos) continue;
    let score = 0;
    for (const tok of chineseTokens(sense.chn)) {
      if (targetTokens.has(tok)) score++;
    }
    if (score > 0) {
      candidates.push({ lemma, pos: sense.pos ?? "", score, chn: sense.chn });
      defByLemma.set(lemma, sense.def);
    }
  }

  // Need at least one hit for the correct answer + 3 for distractors.
  if (candidates.length < 4) {
    // Fall back to the user's own wordbook for filler (better than nothing).
    const known = Array.from(getKnownLemmaSet()).filter(
      (l) => l !== target && !candidates.some((c) => c.lemma === l),
    );
    while (candidates.length < 4 && known.length > 0) {
      const pick = known.shift()!;
      candidates.push({ lemma: pick, pos: "", score: 0, chn: "" });
    }
  }
  if (candidates.length < 4) return null;

  // Top-scoring lemma is the "correct" answer; pick 3 distractors from
  // the rest, biased toward lower scores so the wrong answers are clearly
  // wrong on close inspection.
  candidates.sort((a, b) => b.score - a.score);
  const correct = candidates[0];
  // Reverse-sample distractors from the back half for clearer wrongness.
  const distractors: CandidateBucket[] = [];
  const tail = candidates.slice(1);
  // Shuffle tail for variety.
  for (let i = tail.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tail[i], tail[j]] = [tail[j], tail[i]];
  }
  for (const c of tail) {
    if (distractors.length >= 3) break;
    if (distractors.some((d) => d.lemma === c.lemma)) continue;
    distractors.push(c);
  }
  if (distractors.length < 3) return null;

  // Compose & shuffle the 4 final choices.
  const all = [correct, ...distractors];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const answerIndex = all.findIndex((c) => c.lemma === correct.lemma);

  // Build the per-choice gloss map. Distractors picked from the user's
  // wordbook fallback path won't have chn populated here; resolve those
  // via a fresh dict lookup so the explanation panel still gets data.
  const glossMap: Record<string, ChoiceGloss> = {};
  for (const c of all) {
    let chn = c.chn;
    let def = defByLemma.get(c.lemma);
    let pos = c.pos;
    if (!chn) {
      // fallback path: candidate came from getKnownLemmaSet without sense info
      const got = await lookup(c.lemma);
      const s = got?.entry.senses[0];
      chn = s?.chn ?? "";
      def = s?.def;
      pos = s?.pos ?? pos;
    }
    glossMap[c.lemma] = { pos: pos || undefined, def, chn: chn || undefined };
  }

  // Tokens shared by target & correct answer — the "why they're synonyms"
  // surface area. Limited to a handful so the UI stays compact.
  const correctTokens = new Set(chineseTokens(correct.chn));
  const sharedTokens: string[] = [];
  targetTokens.forEach((tok) => {
    if (sharedTokens.length >= 4) return;
    if (correctTokens.has(tok)) sharedTokens.push(tok);
  });

  return {
    target,
    prompt: { def: primary.def, chn: primary.chn, pos: primary.pos },
    choices: all.map((c) => c.lemma),
    answerIndex,
    glossMap,
    sharedTokens,
  };
}
