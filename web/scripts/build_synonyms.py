"""
build_synonyms.py — offline generator for the review-quiz distractor table.

Pipeline
--------
For every lemma that appears in `web/public/dict/dictionary-index.json`
we emit, per part-of-speech, up to 8 near-synonyms drawn from WordNet.
The resulting file `web/public/dict/synonyms-{a..z|other}.json` powers the
"听单词选近义词" quiz without any AI round-trip.

Shape:
    {
        "quarry": {
            "n": ["prey", "lair", "excavation"],
            "v": ["excavate", "extract", "mine"]
        },
        ...
    }

Only single-word lemmas that exist in our own dict are emitted.
Cross-POS entries share the same top-level key.

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
import string
import sys
from collections import defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, Set

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

# WordNet POS tag → the short tag we ship in the JSON. Keeping these in sync
# with the POS strings used by the OALD dict (`n`, `v`, `adj`, `adv`) means
# the browser can filter by primary-sense POS with no translation layer.
POS_MAP = {
    wn.NOUN: "n",
    wn.VERB: "v",
    wn.ADJ: "adj",
    wn.ADV: "adv",
}

MAX_SYNS_PER_POS = 8


def load_dict_lemmas() -> Set[str]:
    """Every headword in our dictionary. Only these are eligible."""
    with INDEX_PATH.open("r", encoding="utf-8") as f:
        index = json.load(f)
    lemmas: Set[str] = set()
    for lemma in index.keys():
        # WordNet headwords are all-lowercase single words. Skip phrases &
        # anything with punctuation that isn't a hyphen.
        if not lemma:
            continue
        if any(ch in lemma for ch in " '.,;:/"):
            continue
        lemmas.add(lemma.lower())
    return lemmas


def wn_synonyms(lemma: str, pos: str, dict_lemmas: Set[str]) -> List[str]:
    """
    Return up to MAX_SYNS_PER_POS lemmas that:
      * share at least one WordNet synset with `lemma` at POS `pos`,
      * are single words (WordNet uses '_' for phrases — we skip those),
      * are NOT the target itself,
      * exist in our own dictionary (else the UI can't render a gloss).

    Ordering: first pass keeps synset order (WordNet is roughly frequency-
    sorted within a synset); ties broken by insertion order.
    """
    seen: Set[str] = set()
    out: List[str] = []
    for synset in wn.synsets(lemma, pos=pos):
        for wn_lemma in synset.lemmas():
            name = wn_lemma.name().lower()
            if "_" in name or "-" in name and name.count("-") > 1:
                # skip multi-word entries; single hyphenated words are ok
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
                return out
    return out


def shard_of(lemma: str) -> str:
    c = lemma[0].lower() if lemma else ""
    return c if "a" <= c <= "z" else "other"


def build_table(dict_lemmas: Set[str]) -> Dict[str, Dict[str, Dict[str, List[str]]]]:
    """
    Returns a shard → {lemma → {pos → [syns]}} nested dict.
    """
    shards: Dict[str, Dict[str, Dict[str, List[str]]]] = defaultdict(dict)
    n_processed = 0
    n_with_syns = 0

    for lemma in sorted(dict_lemmas):
        n_processed += 1
        if n_processed % 5000 == 0:
            print(f"  … {n_processed} lemmas processed", flush=True)

        by_pos: Dict[str, List[str]] = {}
        for wn_pos, short in POS_MAP.items():
            syns = wn_synonyms(lemma, wn_pos, dict_lemmas)
            if syns:
                by_pos[short] = syns

        if not by_pos:
            continue

        n_with_syns += 1
        shards[shard_of(lemma)][lemma] = by_pos

    print(f"total lemmas: {n_processed}, with synonyms: {n_with_syns}")
    return shards


def write_shards(shards: Dict[str, Dict[str, Dict[str, List[str]]]]) -> None:
    for shard, table in shards.items():
        path = Path(f"{OUT_PREFIX}{shard}.json")
        # Sorted keys → stable diff on regen.
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

    print("building synonym table (this walks WordNet — 1-2 minutes) …")
    shards = build_table(dict_lemmas)

    print("writing shards …")
    write_shards(shards)
    print("done.")


if __name__ == "__main__":
    main()
