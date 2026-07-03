"""
verify_synonyms.py — quick sanity check for the review-quiz distractor logic.

Reads the offline synonyms table + dict shards and prints, for a hand-picked
set of lemmas, the "correct answer" candidates plus what distractors the
front-end algorithm would pick. Lets us eyeball whether options are sensible
without spinning up the browser.

    python3 web/scripts/verify_synonyms.py
"""

from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Dict, List, Optional

random.seed(0)

ROOT = Path(__file__).resolve().parent.parent
DICT_DIR = ROOT / "public" / "dict"

POS_MAP = {"noun": "n", "verb": "v", "adj": "adj", "adv": "adv"}
POS_MAP_STARTS = [("noun", "n"), ("verb", "v"), ("adj", "adj"), ("adv", "adv")]

TARGETS = [
    "quarry",
    "abandon",
    "arouse",
    "eloquent",
    "meticulous",
    "brave",
    "swift",
    "diligent",
    "fragile",
    "obsolete",
    "vivid",
    "concise",
]


def shard_of(lemma: str) -> str:
    c = lemma[0].lower() if lemma else ""
    return c if "a" <= c <= "z" else "other"


def load_json(path: Path):
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def pos_short(pos: Optional[str]) -> Optional[str]:
    if not pos:
        return None
    p = pos.lower()
    for prefix, short in POS_MAP_STARTS:
        if p.startswith(prefix):
            return short
    return None


def distractor_score(target: str, cand: str) -> int:
    if target == cand:
        return 0
    d_len = abs(len(target) - len(cand))
    if d_len > 3:
        return 0
    s = 0
    if target[0] == cand[0]:
        s += 3
    if target[-1] == cand[-1]:
        s += 2
    if d_len == 0:
        s += 2
    elif d_len == 1:
        s += 1
    prefix = 0
    for a, b in zip(target, cand):
        if a != b:
            break
        prefix += 1
    if prefix >= 3:
        s += prefix
    return s


def resolve_entry(dict_shard, lemma):
    rec = dict_shard.get(lemma)
    if not rec or "alias_of" in rec:
        return None
    return rec


def pick_sense(entry, want_pos):
    senses = entry.get("senses") or []
    if not senses:
        return None
    if want_pos:
        for s in senses:
            if pos_short(s.get("pos")) == want_pos:
                return s
    return senses[0]


def main() -> None:
    dict_shards: Dict[str, dict] = {}
    syn_shards: Dict[str, dict] = {}
    for target in TARGETS:
        s = shard_of(target)
        if s not in dict_shards:
            dict_shards[s] = load_json(DICT_DIR / f"dictionary-{s}.json")
        if s not in syn_shards:
            path = DICT_DIR / f"synonyms-{s}.json"
            syn_shards[s] = load_json(path) if path.exists() else {}

    for target in TARGETS:
        s = shard_of(target)
        dict_shard = dict_shards[s]
        syn_shard = syn_shards[s]
        entry = resolve_entry(dict_shard, target)
        if not entry:
            print(f"\n=== {target}: NOT IN DICT — skipped ===")
            continue
        primary = entry["senses"][0] if entry.get("senses") else {}
        target_pos = pos_short(primary.get("pos"))

        offline = syn_shard.get(target, {})
        used_pos = target_pos if target_pos and offline.get(target_pos) else None
        if used_pos is None:
            for p in ("n", "v", "adj", "adv"):
                if offline.get(p):
                    used_pos = p
                    break
        syn_list: List[str] = list(offline.get(used_pos, [])) if used_pos else []

        forbid = {target, *[w for lst in offline.values() for w in lst]}

        # Pick correct answer = first synonym that resolves in dict AND has
        # a POS-matched sense (so the gloss reflects the tested meaning).
        correct = None
        correct_sense = None
        for cand in syn_list:
            e = None
            if cand in dict_shard:
                e = resolve_entry(dict_shard, cand)
            if not e:
                cs = shard_of(cand)
                if cs not in dict_shards:
                    p = DICT_DIR / f"dictionary-{cs}.json"
                    dict_shards[cs] = load_json(p) if p.exists() else {}
                e = resolve_entry(dict_shards[cs], cand)
            if not e:
                continue
            s = pick_sense(e, used_pos)
            if not s:
                continue
            if used_pos and pos_short(s.get("pos")) != used_pos:
                continue
            correct = cand
            correct_sense = s
            break
        # Loose fallback: accept whatever sense we can get.
        if not correct:
            for cand in syn_list:
                cs = shard_of(cand)
                e = resolve_entry(dict_shards.get(cs, {}), cand)
                if not e:
                    continue
                correct = cand
                correct_sense = (e.get("senses") or [{}])[0]
                break
        if not correct:
            print(f"\n=== {target} ({target_pos or '?'}): no dict-resolvable synonym; would fall back to AI ===")
            continue
        forbid.add(correct)

        scored = []
        for lemma, rec in dict_shard.items():
            if lemma in forbid:
                continue
            if not lemma.isalpha() or len(lemma) < 2:
                continue
            if "alias_of" in rec:
                continue
            sense = pick_sense(rec, used_pos)
            if not sense:
                continue
            if used_pos and pos_short(sense.get("pos")) != used_pos:
                continue
            score = distractor_score(target, lemma)
            if score > 0:
                scored.append((score, lemma, sense.get("chn", ""), sense.get("pos", "")))

        scored.sort(key=lambda t: (-t[0], random.random()))
        top = scored[:15]
        random.shuffle(top)
        distractors = top[:3]

        print(f"\n=== {target} ({primary.get('pos','?')}) — {primary.get('chn','')} ===")
        print(f"  ✅ correct: {correct}  ({correct_sense.get('pos','?')})  {correct_sense.get('chn','')}")
        print(f"     source: offline WordNet, pos={used_pos}, syn_list={syn_list}")
        for _, lemma, chn, pos in distractors:
            print(f"  ❌ distractor: {lemma:<14s} ({pos or '?'})  {chn}")


if __name__ == "__main__":
    main()
