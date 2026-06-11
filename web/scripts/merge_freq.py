#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Merge a word frequency list into the dictionary index produced by parse_mdx.py.

Source:
    web/scripts/_freq_en_50k.txt
        Plain text file `<word> <count>` per line, ranked from most to least
        frequent (from hermitdave/FrequencyWords, OpenSubtitles 2018, en_50k).

Effect:
    Updates web/public/dict/index.json so each entry gains a `freq_rank` field:
        - 1   = most frequent word in the source list
        - N+1 = words not present in the source list (sorted to the bottom)
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # /web
FREQ_TXT = ROOT / "scripts" / "_freq_en_50k.txt"
INDEX_JSON = ROOT / "public" / "dict" / "index.json"


def load_freq_ranks() -> dict[str, int]:
    """Return a {lowercase-word: rank} mapping. Lower rank == more frequent."""
    ranks: dict[str, int] = {}
    with FREQ_TXT.open("r", encoding="utf-8") as f:
        for i, line in enumerate(f, start=1):
            parts = line.strip().split()
            if not parts:
                continue
            word = parts[0].lower()
            # Keep the highest rank (= lowest number) per surface form.
            if word not in ranks:
                ranks[word] = i
    return ranks


def main() -> int:
    if not INDEX_JSON.exists():
        print(f"[!] index.json not found, run parse_mdx.py first")
        return 1
    if not FREQ_TXT.exists():
        print(f"[!] frequency list not found at {FREQ_TXT}")
        return 1

    print(f"[+] Loading frequency table: {FREQ_TXT}")
    ranks = load_freq_ranks()
    print(f"    {len(ranks)} ranked words")

    print(f"[+] Loading index: {INDEX_JSON}")
    with INDEX_JSON.open("r", encoding="utf-8") as f:
        index = json.load(f)
    print(f"    {len(index)} entries")

    miss_rank = len(ranks) + 1
    matched = 0
    for entry in index:
        lemma_lc = entry["lemma"].lower()
        # Try the full lemma first; fall back to the first whitespace token
        # (e.g. "10000-foot view" -> "view" doesn't apply, but
        # "look forward to" -> "look" gets a sensible rank).
        rank = ranks.get(lemma_lc)
        if rank is None:
            head = lemma_lc.split()[0] if lemma_lc else ""
            rank = ranks.get(head)
        if rank is None:
            entry["freq_rank"] = miss_rank
        else:
            entry["freq_rank"] = rank
            matched += 1

    print(f"[+] Matched {matched}/{len(index)} entries with a frequency rank")

    # Persist back atomically.
    tmp = INDEX_JSON.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    tmp.replace(INDEX_JSON)
    print(f"[+] Updated index in place: {INDEX_JSON}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
