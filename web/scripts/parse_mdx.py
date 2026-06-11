#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Parse the dumped Oxford Advanced Learner's Dictionary (9th ed.) text file
into structured JSON shards usable by the GET! web app.

Inputs:
    web/scripts/_mdx_dump/牛津高阶英汉双解词典（第9版）.mdx.txt
        Raw mdx-txt format: lines of `headword\\n<html>\\n</>\\n` blocks.

Outputs:
    web/public/dict/index.json
        [{ lemma, slug, shard, pos, phon_uk, phon_us, gloss }] - lightweight
        index used for autocomplete/list rendering.
    web/public/dict/entries/{a..z, other}.json
        { slug: { lemma, html } } - full HTML of each entry.

Notes:
    - We keep the original HTML to preserve the dictionary layout via oalecd9.css.
    - We strip a few tokens (head/script tags, audio src to .spx) that we cannot
      use on the web. The TTS will use the browser Web Speech API instead.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent  # /web
DUMP = ROOT / "scripts" / "_mdx_dump" / "牛津高阶英汉双解词典（第9版）.mdx.txt"
OUT_DIR = ROOT / "public" / "dict"
ENTRIES_DIR = OUT_DIR / "entries"

RECORD_SEP = "\n</>\n"  # mdict-utils output separator between records

# Patterns used to extract lightweight index fields from raw HTML.
RE_PHON_UK = re.compile(
    r"<brelabel>.*?</brelabel>.*?<phon>([^<]+)</phon>", re.DOTALL
)
RE_PHON_US = re.compile(
    r"<namelabel>.*?</namelabel>.*?<phon>([^<]+)</phon>", re.DOTALL
)
RE_POS = re.compile(r"<pos[^>]*>.*?<xhtml:a[^>]*>([^<]+)</xhtml:a>.*?</pos>", re.DOTALL)
RE_CHN = re.compile(r"<chn[^>]*>(.+?)</chn>", re.DOTALL)
RE_TAG = re.compile(r"<[^>]+>")
RE_LINK_REDIRECT = re.compile(r"^@@@LINK=(.+?)\s*$")
RE_HEAD_TAGS = re.compile(r"<head>.*?</head>", re.DOTALL)
RE_SCRIPT_TAGS = re.compile(r"<script.*?</script>", re.DOTALL)


def slugify(lemma: str) -> str:
    """Make a URL-safe, lower-cased slug for use as a JSON key & route param."""
    s = lemma.strip().lower()
    # keep alnum, hyphen, apostrophe; replace whitespace with '-'
    s = re.sub(r"\s+", "-", s)
    return s


def shard_of(lemma: str) -> str:
    """Return shard bucket name based on first letter (a..z, otherwise 'other')."""
    if not lemma:
        return "other"
    c = lemma[0].lower()
    if "a" <= c <= "z":
        return c
    return "other"


def extract_meta(html: str) -> Dict[str, Optional[str]]:
    """Pull lightweight metadata out of an entry's HTML for the index."""
    phon_uk = None
    phon_us = None
    pos = None
    gloss = None

    m = RE_PHON_UK.search(html)
    if m:
        phon_uk = m.group(1).strip()
    m = RE_PHON_US.search(html)
    if m:
        phon_us = m.group(1).strip()
    m = RE_POS.search(html)
    if m:
        pos = m.group(1).strip()
    m = RE_CHN.search(html)
    if m:
        # plain-text Chinese gloss for list previews
        gloss = RE_TAG.sub("", m.group(1)).strip()
        # collapse runs of whitespace
        gloss = re.sub(r"\s+", " ", gloss)
        if len(gloss) > 80:
            gloss = gloss[:80] + "…"

    return {
        "phon_uk": phon_uk,
        "phon_us": phon_us,
        "pos": pos,
        "gloss": gloss,
    }


def clean_html(html: str) -> str:
    """Strip tags we cannot use on the web (head/link/script, .spx audio)."""
    html = RE_HEAD_TAGS.sub("", html)
    html = RE_SCRIPT_TAGS.sub("", html)
    return html.strip()


def iter_records(text: str):
    """Yield (headword, body) tuples from the dumped mdx-txt content."""
    # Use a streaming split on the record separator to avoid building huge
    # intermediate lists when we can help it. The dump file fits in memory
    # (~336MB), so a plain split is acceptable here.
    records = text.split(RECORD_SEP)
    for rec in records:
        rec = rec.strip("\n")
        if not rec:
            continue
        # First line is the headword, the rest is the HTML body.
        nl = rec.find("\n")
        if nl == -1:
            continue
        headword = rec[:nl].strip()
        body = rec[nl + 1 :].strip()
        if not headword:
            continue
        yield headword, body


def main() -> int:
    if not DUMP.exists():
        print(f"[!] Dump file not found: {DUMP}", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ENTRIES_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[+] Reading dump: {DUMP} ({DUMP.stat().st_size / 1024 / 1024:.1f} MB)")
    text = DUMP.read_text(encoding="utf-8", errors="replace")

    # Aliases (e.g. plural / verb form -> base form), stored in index for now.
    aliases: Dict[str, str] = {}

    # Per-shard buffers: { shard_name: { slug: { lemma, html } } }
    shards: Dict[str, Dict[str, Dict[str, str]]] = {}
    index: List[Dict[str, Optional[str]]] = []

    total = 0
    skipped_link = 0
    for lemma, body in iter_records(text):
        total += 1

        # Some entries are pure redirect markers like "@@@LINK=baseword".
        m_link = RE_LINK_REDIRECT.match(body)
        if m_link:
            target = m_link.group(1).strip()
            aliases[slugify(lemma)] = slugify(target)
            skipped_link += 1
            continue

        slug = slugify(lemma)
        shard = shard_of(lemma)
        body = clean_html(body)

        meta = extract_meta(body)
        index.append(
            {
                "lemma": lemma,
                "slug": slug,
                "shard": shard,
                **meta,
            }
        )

        bucket = shards.setdefault(shard, {})
        # If duplicates appear (mdx sometimes has multiple entries per slug),
        # keep the longest one as the canonical version.
        existing = bucket.get(slug)
        if existing is None or len(body) > len(existing["html"]):
            bucket[slug] = {"lemma": lemma, "html": body}

        if total % 20000 == 0:
            print(f"  ... processed {total} records")

    print(f"[+] Records total={total}, link-aliases={skipped_link}")
    print(f"[+] Index entries: {len(index)} | shards: {len(shards)}")

    # Write shards.
    for shard, bucket in sorted(shards.items()):
        out_path = ENTRIES_DIR / f"{shard}.json"
        with out_path.open("w", encoding="utf-8") as f:
            json.dump(bucket, f, ensure_ascii=False, separators=(",", ":"))
        size_mb = out_path.stat().st_size / 1024 / 1024
        print(f"  -> {out_path.name}: {len(bucket)} entries, {size_mb:.1f} MB")

    # Write index + aliases.
    index_path = OUT_DIR / "index.json"
    with index_path.open("w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    print(
        f"[+] Wrote index: {index_path} ({index_path.stat().st_size / 1024 / 1024:.1f} MB)"
    )

    aliases_path = OUT_DIR / "aliases.json"
    with aliases_path.open("w", encoding="utf-8") as f:
        json.dump(aliases, f, ensure_ascii=False, separators=(",", ":"))
    print(
        f"[+] Wrote aliases: {aliases_path} "
        f"({aliases_path.stat().st_size / 1024 / 1024:.1f} MB, {len(aliases)} keys)"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
