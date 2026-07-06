"""
build_synonyms.py — offline generator for the review-quiz distractor table.

Pipeline
--------
For every lemma that appears in `web/public/dict/dictionary-index.json`
we emit, per part-of-speech, up to 8 near-synonyms drawn from WordNet —
BUT ONLY from the WordNet synset whose gloss best matches the OALD
dictionary's primary sense at that POS. This alignment step is what
prevents nonsense like `quarry (采石场) → prey/target/pit` where WordNet
returns synonyms for a *secondary* sense that the user never sees.

Alignment algorithm
-------------------
For each (lemma, pos):
  1. Read the OALD entry from dictionary-{shard}.json and take the FIRST
     sense whose pos matches — this is the sense the quiz will show.
  2. Tokenise its `def` (English gloss) into a bag of content words.
  3. For every candidate WordNet synset at this pos, tokenise
     `synset.definition()` the same way and compute Jaccard similarity.
  4. Keep the best-scoring synset only if its score ≥ MIN_SYNSET_SCORE.
     Otherwise emit no synonyms for this pos — the frontend will fall
     back to a spelling question, which is way better than teaching a
     wrong association.

Shape:
    {
        "quarry": {
            "v": ["excavate", "extract", "mine"]   // 采石 sense only
        },
        // no "n" entry — WordNet's noun synonyms cover the "prey"
        // sense, which doesn't match the OALD primary "采石场" gloss.
    }

Only single-word lemmas that exist in our own dict are emitted.

Prerequisites
-------------
    python3 -m pip install nltk
    python3 -c "import nltk; nltk.download('wordnet'); nltk.download('omw-1.4')"

Usage
-----
    python3 web/scripts/build_synonyms.py
"""

from __future__ import annotations

import json
import os
import re
import string
import sys
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

try:
    from nltk.corpus import wordnet as wn
except ImportError as exc:  # pragma: no cover
    sys.stderr.write(
        "nltk not installed. Run:\n"
        "  python3 -m pip install nltk\n"
        "  python3 -c \"import nltk; nltk.download('wordnet'); nltk.download('omw-1.4')\"\n"
    )
    raise SystemExit(1) from exc

ROOT = Path(__file__).resolve().parent.parent
DICT_DIR = ROOT / "public" / "dict"
INDEX_PATH = DICT_DIR / "dictionary-index.json"
OUT_PREFIX = DICT_DIR / "synonyms-"

# WordNet POS tag → the short tag we ship in the JSON.
POS_MAP = {
    wn.NOUN: "n",
    wn.VERB: "v",
    wn.ADJ: "adj",
    wn.ADV: "adv",
}

# OALD `pos` string prefix → our short tag.
OALD_POS_PREFIX = [
    ("noun", "n"),
    ("verb", "v"),
    ("adj", "adj"),
    ("adv", "adv"),
]

MAX_SYNS_PER_POS = 8
# Jaccard threshold for "this WordNet synset actually describes the same
# sense as the OALD entry". Tuned by hand on ~30 multi-sense words: 0.15
# rejects `quarry.n` (prey/pit) while keeping `swift.adj` (rapid/fleet).
MIN_SYNSET_SCORE = 0.15

# Content-word extraction for Jaccard comparison. English stop-words that
# appear in almost every dictionary gloss and would only add noise.
STOPWORDS: Set[str] = {
    "a", "an", "the", "of", "to", "in", "on", "at", "for", "with", "by",
    "from", "as", "is", "are", "was", "were", "be", "been", "being",
    "that", "this", "these", "those", "it", "its", "or", "and", "but",
    "not", "no", "so", "if", "then", "than", "into", "onto", "upon",
    "out", "up", "down", "off", "over", "under", "about", "very", "also",
    "such", "which", "who", "whom", "whose", "what", "when", "where",
    "why", "how", "you", "your", "yours", "he", "she", "they", "them",
    "his", "her", "hers", "him", "himself", "herself", "themselves",
    "someone", "somebody", "something", "anyone", "anybody", "anything",
    "person", "thing", "way", "one", "ones", "other", "others", "another",
    "used", "using", "use", "usually", "often", "many", "much", "some",
    "any", "all", "every", "each", "same", "different", "have", "has",
    "had", "do", "does", "did", "done", "make", "makes", "made", "get",
    "gets", "got", "can", "could", "will", "would", "should", "may",
    "might", "must", "there", "here", "etc", "eg", "ie",
}

_WORD_RE = re.compile(r"[a-z]+")


def tokenize(text: str) -> Set[str]:
    """Lowercase content-word bag for Jaccard scoring."""
    if not text:
        return set()
    return {
        w for w in _WORD_RE.findall(text.lower())
        if len(w) >= 3 and w not in STOPWORDS
    }


def jaccard(a: Set[str], b: Set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    if inter == 0:
        return 0.0
    return inter / len(a | b)


def load_dict_lemmas() -> Set[str]:
    """Every headword in our dictionary. Only these are eligible."""
    with INDEX_PATH.open("r", encoding="utf-8") as f:
        index = json.load(f)
    lemmas: Set[str] = set()
    for lemma in index.keys():
        if not lemma:
            continue
        if any(ch in lemma for ch in " '.,;:/"):
            continue
        lemmas.add(lemma.lower())
    return lemmas


def shard_of(lemma: str) -> str:
    c = lemma[0].lower() if lemma else ""
    return c if "a" <= c <= "z" else "other"


# ---------------------------------------------------------------------------
# Dictionary loading (all shards, once)
# ---------------------------------------------------------------------------

def load_all_dict_shards() -> Dict[str, dict]:
    """
    Load every dictionary-{shard}.json into memory. Roughly 40k lemmas ×
    ~1KB each = ~40MB, comfortably fine for a build script.
    Returns {lemma: entry_dict}.
    """
    merged: Dict[str, dict] = {}
    for path in sorted(DICT_DIR.glob("dictionary-*.json")):
        if path.name == "dictionary-index.json":
            continue
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        for lemma, entry in data.items():
            if isinstance(entry, dict) and "senses" in entry:
                merged[lemma.lower()] = entry
    return merged


def oald_pos_short(pos: Optional[str]) -> Optional[str]:
    """Map an OALD sense.pos string ('noun', 'transitive verb', ...) to
    our short tag."""
    if not pos:
        return None
    p = pos.lower()
    for prefix, short in OALD_POS_PREFIX:
        if p.startswith(prefix):
            return short
    return None


def primary_sense_for_pos(entry: dict, want_pos: str) -> Optional[dict]:
    """Return the first sense in `entry` whose OALD pos matches `want_pos`
    (short tag), or None."""
    for s in entry.get("senses", []):
        if oald_pos_short(s.get("pos")) == want_pos:
            return s
    return None


# ---------------------------------------------------------------------------
# WordNet synonym selection with sense alignment
# ---------------------------------------------------------------------------

def wn_synonyms_aligned(
    lemma: str,
    wn_pos: str,
    short_pos: str,
    dict_entry: dict,
    dict_lemmas: Set[str],
) -> List[str]:
    """
    Pick up to MAX_SYNS_PER_POS single-word synonyms of `lemma` at `wn_pos`,
    but only from the WordNet synset that best matches the OALD dict's
    primary sense at this POS. Returns [] if no synset scores above
    MIN_SYNSET_SCORE — meaning we couldn't confidently align WordNet's
    coverage to what the user actually sees in the app.
    """
    oald_sense = primary_sense_for_pos(dict_entry, short_pos)
    if not oald_sense:
        return []
    # Combine English + Chinese-free tokens from the OALD gloss. `chn` is
    # Chinese so it won't match, but `def` is English and drives alignment.
    dict_tokens = tokenize(oald_sense.get("def", ""))
    if not dict_tokens:
        return []

    all_synsets = wn.synsets(lemma, pos=wn_pos)
    if not all_synsets:
        return []

    # Short-circuit: if WordNet only has one synset for this (lemma, pos),
    # there's nothing to disambiguate — accept it. Sense-mismatch bugs
    # only exist when WordNet has multiple senses to choose from. This
    # rescues borderline cases like `swift.adj` where the only synset is
    # `fleet.s.01: moving very fast` but Jaccard vs OALD "happening or
    # done quickly" scores 0 due to the "fast" vs "quickly" wording gap.
    if len(all_synsets) == 1:
        best_synset = all_synsets[0]
    else:
        best_synset = None
        best_score = 0.0
        for synset in all_synsets:
            wn_tokens = tokenize(synset.definition())
            score = jaccard(dict_tokens, wn_tokens)
            if score > best_score:
                best_score = score
                best_synset = synset
        if best_synset is None or best_score < MIN_SYNSET_SCORE:
            return []

    seen: Set[str] = set()
    out: List[str] = []
    for wn_lemma in best_synset.lemmas():
        name = wn_lemma.name().lower()
        if "_" in name:
            continue
        if not all(ch in string.ascii_lowercase + "-" for ch in name):
            continue
        if name == lemma or name in seen:
            continue
        if name not in dict_lemmas:
            continue
        seen.add(name)
        out.append(name)
        if len(out) >= MAX_SYNS_PER_POS:
            break

    # Also pull from `also_sees` and `similar_tos` for adjectives — WordNet
    # keeps adj synonyms in a linked synset rather than the same one.
    if len(out) < MAX_SYNS_PER_POS and wn_pos == wn.ADJ:
        for related in best_synset.similar_tos():
            for wn_lemma in related.lemmas():
                name = wn_lemma.name().lower()
                if "_" in name or not all(
                    ch in string.ascii_lowercase + "-" for ch in name
                ):
                    continue
                if name == lemma or name in seen or name not in dict_lemmas:
                    continue
                seen.add(name)
                out.append(name)
                if len(out) >= MAX_SYNS_PER_POS:
                    break
            if len(out) >= MAX_SYNS_PER_POS:
                break

    return out


# ---------------------------------------------------------------------------
# Build & write
# ---------------------------------------------------------------------------

def build_table(
    dict_lemmas: Set[str],
    dict_entries: Dict[str, dict],
) -> Tuple[Dict[str, Dict[str, Dict[str, List[str]]]], Dict[str, int]]:
    shards: Dict[str, Dict[str, Dict[str, List[str]]]] = defaultdict(dict)
    stats = {"processed": 0, "with_syns": 0, "skipped_no_align": 0}

    for lemma in sorted(dict_lemmas):
        stats["processed"] += 1
        if stats["processed"] % 5000 == 0:
            print(f"  … {stats['processed']} lemmas processed", flush=True)

        entry = dict_entries.get(lemma)
        if not entry:
            continue

        by_pos: Dict[str, List[str]] = {}
        had_wn_but_unaligned = False
        for wn_pos, short in POS_MAP.items():
            # Only bother if the OALD entry actually has this POS — no
            # point emitting adj synonyms for a noun-only word.
            if primary_sense_for_pos(entry, short) is None:
                continue
            if not wn.synsets(lemma, pos=wn_pos):
                continue
            syns = wn_synonyms_aligned(
                lemma, wn_pos, short, entry, dict_lemmas
            )
            if syns:
                by_pos[short] = syns
            else:
                had_wn_but_unaligned = True

        if not by_pos:
            if had_wn_but_unaligned:
                stats["skipped_no_align"] += 1
            continue

        stats["with_syns"] += 1
        shards[shard_of(lemma)][lemma] = by_pos

    return shards, stats


def write_shards(shards: Dict[str, Dict[str, Dict[str, List[str]]]]) -> None:
    for shard, table in shards.items():
        path = Path(f"{OUT_PREFIX}{shard}.json")
        with path.open("w", encoding="utf-8") as f:
            json.dump(table, f, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        size_kb = os.path.getsize(path) / 1024
        print(f"wrote {path.name}  ({len(table)} lemmas, {size_kb:.1f} KB)")


def main() -> None:
    if not INDEX_PATH.exists():
        sys.exit(f"dictionary index not found at {INDEX_PATH}")

    print(f"loading dictionary lemmas from {INDEX_PATH.name} …")
    dict_lemmas = load_dict_lemmas()
    print(f"  {len(dict_lemmas)} eligible single-word lemmas")

    print("loading dictionary entries (all shards) …")
    dict_entries = load_all_dict_shards()
    print(f"  {len(dict_entries)} entries loaded")

    print("building sense-aligned synonym table (walks WordNet — 1-2 min) …")
    shards, stats = build_table(dict_lemmas, dict_entries)
    print(
        f"total: {stats['processed']} | with_syns: {stats['with_syns']} | "
        f"skipped_no_align: {stats['skipped_no_align']}"
    )

    print("writing shards …")
    write_shards(shards)
    print("done.")


if __name__ == "__main__":
    main()
