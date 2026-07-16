#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Parse the Oxford 9th Edition mdx into structured JSON files.

Why this lives here, not in an npm package:
  - The mdx format is a binary container (zlib-compressed KEY / RECORD blocks
    with an XML header). It's a one-off ETL step that runs locally; we don't
    want to ship the parser to the browser.
  - This script intentionally has zero third-party deps so it runs on the
    stock macOS Python 3 (we hit Python 3.9 in this environment).

Output (written to web/public/dict/):
  - dictionary-{a..z,other}.json   — sharded by first letter for lazy loading
  - dictionary-index.json          — { lemma: shard } map for O(1) lookup
  - lemma-list.json                — array of all lemmas (sorted) for prefix
                                     suggestions

Each entry has the shape (after structural extraction):
  {
    "lemma":  "abandon",
    "phon":   { "uk": "əˈbændən", "us": "əˈbændən" },
    "senses": [
      {
        "pos":  "verb",
        "def":  "to leave sb, especially sb you are responsible for, …",
        "chn":  "（不顾责任、义务等）离弃，遗弃，抛弃",
        "ex":   [
          { "en": "The baby had been abandoned by its mother.",
            "cn": "这个婴儿被母亲遗弃了。" }
        ]
      },
      …
    ],
    "phrases": [
      { "pattern": "~ to sth",
        "filled":  "prone to sth",
        "example": { "en": "prone to injury", "cn": "容易受伤" } }
    ],
    "alias_of": "abandoned"   # only present for cross-ref entries
  }

Storing structured fields (instead of the raw mdx HTML) cuts the per-entry
size from ~25 KB → ~1–2 KB, which is what makes IndexedDB / offline viable.
"""

from __future__ import annotations

import html
import json
import os
import re
import struct
import sys
import zlib
from pathlib import Path
from typing import Iterator, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Low-level mdx reader
# ---------------------------------------------------------------------------

def _read_header(f) -> dict:
    """Read the XML header at the top of an mdx file and return its attrs."""
    header_len = struct.unpack(">I", f.read(4))[0]
    header_bytes = f.read(header_len)
    f.read(4)  # adler32 of header — we trust the file
    header_text = header_bytes.decode("utf-16-le").rstrip("\x00")
    attrs = {}
    for m in re.finditer(r'(\w+)="([^"]*)"', header_text):
        attrs[m.group(1)] = m.group(2)
    return attrs


def _read_number(f, version: float):
    if version >= 2.0:
        return struct.unpack(">Q", f.read(8))[0]
    return struct.unpack(">I", f.read(4))[0]


def _decompress_block(block: bytes) -> bytes:
    tag = block[:4]
    body = block[8:]  # skip tag (4) + adler32 (4)
    if tag[:1] == b"\x02":
        return zlib.decompress(body)
    if tag[:1] == b"\x00":
        return body
    raise RuntimeError(f"Unsupported mdx block compression tag: {tag!r}")


def _iter_keys(f, version: float, encoding: str) -> Iterator[Tuple[int, str]]:
    num_blocks = _read_number(f, version)
    _num_entries = _read_number(f, version)
    if version >= 2.0:
        _key_index_decomp_len = _read_number(f, version)
    key_index_comp_len = _read_number(f, version)
    key_blocks_len = _read_number(f, version)
    if version >= 2.0:
        f.read(4)

    key_index_raw = f.read(key_index_comp_len)
    if version >= 2.0:
        key_index = _decompress_block(key_index_raw)
    else:
        key_index = key_index_raw

    blocks_meta = []
    pos = 0
    for _ in range(num_blocks):
        n_entries = struct.unpack(">Q" if version >= 2.0 else ">I",
                                  key_index[pos:pos + (8 if version >= 2.0 else 4)])[0]
        pos += 8 if version >= 2.0 else 4
        if version >= 2.0:
            text_len = struct.unpack(">H", key_index[pos:pos + 2])[0]
            pos += 2
            term = 1
        else:
            text_len = struct.unpack(">B", key_index[pos:pos + 1])[0]
            pos += 1
            term = 0
        width = 2 if encoding.lower().startswith("utf-16") else 1
        pos += text_len * width + term * width
        if version >= 2.0:
            text_len = struct.unpack(">H", key_index[pos:pos + 2])[0]
            pos += 2
        else:
            text_len = struct.unpack(">B", key_index[pos:pos + 1])[0]
            pos += 1
        pos += text_len * width + term * width
        comp_size = struct.unpack(">Q" if version >= 2.0 else ">I",
                                  key_index[pos:pos + (8 if version >= 2.0 else 4)])[0]
        pos += 8 if version >= 2.0 else 4
        decomp_size = struct.unpack(">Q" if version >= 2.0 else ">I",
                                    key_index[pos:pos + (8 if version >= 2.0 else 4)])[0]
        pos += 8 if version >= 2.0 else 4
        blocks_meta.append((n_entries, comp_size, decomp_size))

    for _n_entries, comp_size, _decomp_size in blocks_meta:
        block_raw = f.read(comp_size)
        block = _decompress_block(block_raw)
        bp = 0
        while bp < len(block):
            if version >= 2.0:
                rec_offset = struct.unpack(">Q", block[bp:bp + 8])[0]
                bp += 8
            else:
                rec_offset = struct.unpack(">I", block[bp:bp + 4])[0]
                bp += 4
            if encoding.lower().startswith("utf-16"):
                end = block.find(b"\x00\x00", bp)
                while end != -1 and (end - bp) % 2 != 0:
                    end = block.find(b"\x00\x00", end + 1)
                key_bytes = block[bp:end]
                bp = end + 2
                key = key_bytes.decode("utf-16-le", errors="ignore")
            else:
                end = block.find(b"\x00", bp)
                key_bytes = block[bp:end]
                bp = end + 1
                key = key_bytes.decode(encoding or "utf-8", errors="ignore")
            yield rec_offset, key


def _read_records(f, version: float) -> bytes:
    num_blocks = _read_number(f, version)
    _num_entries = _read_number(f, version)
    _record_index_len = _read_number(f, version)
    _record_blocks_len = _read_number(f, version)

    blocks_meta = []
    width = 8 if version >= 2.0 else 4
    fmt = ">Q" if version >= 2.0 else ">I"
    for _ in range(num_blocks):
        comp = struct.unpack(fmt, f.read(width))[0]
        decomp = struct.unpack(fmt, f.read(width))[0]
        blocks_meta.append((comp, decomp))

    out = bytearray()
    for comp, _decomp in blocks_meta:
        block_raw = f.read(comp)
        out.extend(_decompress_block(block_raw))
    return bytes(out)


def parse_mdx(path: Path) -> Iterator[Tuple[str, str]]:
    with path.open("rb") as f:
        attrs = _read_header(f)
        version = float(attrs.get("GeneratedByEngineVersion", "2.0"))
        encoding = attrs.get("Encoding", "UTF-8") or "UTF-8"
        keys = list(_iter_keys(f, version, encoding))
        records_blob = _read_records(f, version)

    keys_sorted = sorted(set(keys), key=lambda kv: kv[0])
    for i, (offset, key) in enumerate(keys_sorted):
        end = (keys_sorted[i + 1][0]
               if i + 1 < len(keys_sorted)
               else len(records_blob))
        raw = records_blob[offset:end]
        if encoding.lower().startswith("utf-16"):
            text = raw.decode("utf-16-le", errors="ignore").rstrip("\x00")
        else:
            text = raw.decode(encoding or "utf-8", errors="ignore").rstrip("\x00")
        yield key, text


# ---------------------------------------------------------------------------
# HTML → structured fields extractor
# ---------------------------------------------------------------------------
#
# The Oxford 9 mdx ships its own custom skin. The interesting tags are:
#   <phon>           — phonetic transcription. There are two per entry, one
#                       inside a BrE block and one inside a NAmE block.
#   <pos>            — part of speech (verb / noun / adj …)
#   <sn-g>           — one sense unit; contains:
#                        <def>   English definition
#                        <chn>   Chinese gloss (we keep the chinese-only part)
#                        <x>     example sentence (English); each <x> may
#                                contain a nested <chn> with the translation.
#
# We're deliberately tolerant: malformed nesting just yields fewer fields, never
# crashes the pipeline.

_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")


def _strip_tags(s: str) -> str:
    """Drop every tag and collapse whitespace; decodes HTML entities."""
    return _WHITESPACE_RE.sub(" ", html.unescape(_TAG_RE.sub("", s))).strip()


def _find_blocks(haystack: str, tag: str) -> Iterator[Tuple[int, int, str]]:
    """Yield (start, end, inner_html) for every <tag …>…</tag> in haystack.

    Nested same-tag is handled by tracking depth. We don't try to be a real
    parser — Oxford mdx HTML is well-formed enough for this to work.
    """
    open_re = re.compile(rf"<{tag}(?:\s[^>]*)?>", re.IGNORECASE)
    close_re = re.compile(rf"</{tag}>", re.IGNORECASE)
    pos = 0
    while True:
        m_open = open_re.search(haystack, pos)
        if not m_open:
            return
        depth = 1
        scan = m_open.end()
        while depth > 0:
            m_next_open = open_re.search(haystack, scan)
            m_next_close = close_re.search(haystack, scan)
            if not m_next_close:
                # unbalanced — bail out, skip this block
                pos = m_open.end()
                break
            if m_next_open and m_next_open.start() < m_next_close.start():
                depth += 1
                scan = m_next_open.end()
            else:
                depth -= 1
                scan = m_next_close.end()
        else:
            yield m_open.start(), scan, haystack[m_open.end():scan - len(f"</{tag}>")]
            pos = scan
            continue
        # only reached on the unbalanced bail-out path
        continue


def _extract_phonetics(html_str: str) -> dict:
    """Pull the BrE and NAmE phonetic strings out of <pron-g-blk> regions."""
    out: dict = {}
    # The mdx labels each pron block with <brelabel>…BrE…</brelabel> or
    # <namelabel>…NAmE…</namelabel> right before the <pron-g>. We just look
    # for those two markers and take the FIRST <phon> after each.
    for region_label, key in (("brelabel", "uk"), ("namelabel", "us")):
        m_label = re.search(rf"<{region_label}\b[^>]*>", html_str, re.IGNORECASE)
        if not m_label:
            continue
        # take the first <phon>…</phon> that appears after this label.
        # NB: must NOT match <phon-blk> — \b doesn't help because '-' is a
        # non-word char so "\\bphon\\b" still hits "phon-blk". Anchor on the
        # closing '>' / whitespace explicitly.
        tail = html_str[m_label.end():m_label.end() + 2000]
        m_phon = re.search(r"<phon(?:\s[^>]*)?>(.*?)</phon>", tail,
                           re.IGNORECASE | re.DOTALL)
        if m_phon:
            text = _strip_tags(m_phon.group(1))
            if text:
                out[key] = text
    return out


def _extract_examples(sense_html: str) -> List[dict]:
    """Find <x …>…</x> example blocks and split English / Chinese."""
    examples: List[dict] = []
    for _s, _e, inner in _find_blocks(sense_html, "x"):
        # split on the first <chn> — everything before is the English sentence,
        # the <chn> body is the translation.
        m_chn = re.search(r"<chn\b[^>]*>(.*?)</chn>", inner,
                          re.IGNORECASE | re.DOTALL)
        if m_chn:
            en = _strip_tags(inner[:m_chn.start()])
            cn = _strip_tags(m_chn.group(1))
        else:
            en = _strip_tags(inner)
            cn = ""
        # skip degenerate examples (no English, or just punctuation)
        if not en or not re.search(r"[A-Za-z]", en):
            continue
        ex: dict = {"en": en}
        if cn:
            ex["cn"] = cn
        examples.append(ex)
        # cap per sense — Oxford rarely exceeds 6 anyway
        if len(examples) >= 6:
            break
    return examples


def _extract_phrases(lemma: str, html_str: str) -> List[dict]:
    """Pull collocation frames (`<cf-blk><cf>~ to sth</cf></cf-blk>`) out of
    the full entry HTML, along with the nearest following example sentence.

    Oxford encodes typical patterns via a `<cf>` box that sits inside an
    `<x-g-blk>` right before the example itself, e.g.

        <x-g-blk>
          <cf-blk><cf><exp>~</exp> to sth</cf></cf-blk>
          <x>prone to injury <chn>容易受伤</chn></x>
        </x-g-blk>

    The `~` inside `<exp>` is a placeholder for the lemma, so we render both
    the raw `pattern` (kept for reference) and a `filled` form with `~`
    substituted so the UI can display "prone to sth" directly.

    De-duplicates by `pattern` (case-insensitive, whitespace-normalised) to
    avoid ~10 copies of "~ sth" for verbs like `take`. Preserves entry order
    so the most-important patterns (which Oxford lists first) stay on top.
    """
    phrases: List[dict] = []
    seen: set = set()

    # Iterate every <cf-blk>. For each one, find the enclosing <x-g-blk> so
    # we can pull the accompanying example. If the cf sits outside any
    # <x-g-blk> (rare) we still keep the pattern, just without an example.
    xg_blocks: List[Tuple[int, int]] = []
    for m in re.finditer(r"<x-g-blk\b[^>]*>", html_str, re.IGNORECASE):
        # find matching </x-g-blk>. Use a shallow scan — these blocks don't
        # nest in the mdx we care about.
        end_m = re.search(r"</x-g-blk>", html_str[m.end():], re.IGNORECASE)
        if not end_m:
            continue
        xg_blocks.append((m.start(), m.end() + end_m.end()))

    def _find_containing_xg(offset: int) -> Optional[Tuple[int, int]]:
        for a, b in xg_blocks:
            if a <= offset < b:
                return a, b
        return None

    for cf_m in re.finditer(
        r"<cf-blk\b[^>]*>(.*?)</cf-blk>", html_str,
        re.IGNORECASE | re.DOTALL,
    ):
        pattern = _strip_tags(cf_m.group(1))
        if not pattern:
            continue
        # Normalise a bit: collapse spaces around the ~ but leave the rest
        # verbatim; Oxford's own copy is already good.
        pattern = re.sub(r"\s+", " ", pattern).strip()
        norm = pattern.lower()
        if norm in seen:
            continue
        seen.add(norm)
        # Render a human-readable form with `~` replaced by the lemma.
        # Handle "~ sth" → "<lemma> sth" and also patterns where `~` sits
        # inside parentheses ("(~ sth)") — a plain substring replace works
        # because `~` never legitimately appears anywhere else.
        filled = pattern.replace("~", lemma) if "~" in pattern else pattern

        phrase: dict = {"pattern": pattern, "filled": filled}
        # Attach the nearest example inside the same <x-g-blk>, if any.
        xg = _find_containing_xg(cf_m.start())
        if xg is not None:
            a, b = xg
            xg_inner = html_str[a:b]
            m_x = re.search(
                r"<x\b(?![a-z-])[^>]*>(.*?)</x>", xg_inner,
                re.IGNORECASE | re.DOTALL,
            )
            if m_x:
                x_inner = m_x.group(1)
                m_chn = re.search(
                    r"<chn\b[^>]*>(.*?)</chn>", x_inner,
                    re.IGNORECASE | re.DOTALL,
                )
                if m_chn:
                    en = _strip_tags(x_inner[:m_chn.start()])
                    cn = _strip_tags(m_chn.group(1))
                else:
                    en = _strip_tags(x_inner)
                    cn = ""
                if en and re.search(r"[A-Za-z]", en):
                    ex: dict = {"en": en}
                    if cn:
                        ex["cn"] = cn
                    phrase["example"] = ex
        phrases.append(phrase)
        # Hard cap — even `take` doesn't need more than 20 in the payload.
        if len(phrases) >= 20:
            break
    return phrases


def _extract_senses(html_str: str) -> List[dict]:
    """Walk every <sn-g …>…</sn-g> and pull out def / chn / examples.

    Part-of-speech is found by looking back from each <sn-g> to the nearest
    preceding <pos>…</pos>. The mdx groups senses under a <subentry-g> per
    pos, so this "nearest preceding" rule is reliable.
    """
    senses: List[dict] = []
    # Pre-compute pos positions so we can binary-search the nearest one.
    pos_spans: List[Tuple[int, str]] = []
    for m in re.finditer(r"<pos\b[^>]*>(.*?)</pos>", html_str,
                         re.IGNORECASE | re.DOTALL):
        text = _strip_tags(m.group(1))
        if text:
            pos_spans.append((m.start(), text))

    def pos_for(offset: int) -> str:
        candidate = ""
        for at, text in pos_spans:
            if at <= offset:
                candidate = text
            else:
                break
        return candidate

    for s, _e, inner in _find_blocks(html_str, "sn-g"):
        m_def = re.search(r"<def\b[^>]*>(.*?)</def>", inner,
                          re.IGNORECASE | re.DOTALL)
        if not m_def:
            continue
        def_inner = m_def.group(1)
        # the chinese gloss lives inside <chn> at the tail of <def>
        m_chn = re.search(r"<chn\b[^>]*>(.*?)</chn>", def_inner,
                          re.IGNORECASE | re.DOTALL)
        if m_chn:
            en_def = _strip_tags(def_inner[:m_chn.start()])
            zh_def = _strip_tags(m_chn.group(1))
        else:
            en_def = _strip_tags(def_inner)
            zh_def = ""
        if not en_def and not zh_def:
            continue
        # examples lie OUTSIDE <def>, but inside the same <sn-g>; pass `inner`
        examples = _extract_examples(inner)
        sense: dict = {"pos": pos_for(s)}
        if en_def:
            sense["def"] = en_def
        if zh_def:
            sense["chn"] = zh_def
        if examples:
            sense["ex"] = examples
        senses.append(sense)
    return senses


def extract_entry(lemma: str, html_str: str) -> Optional[dict]:
    """Turn the raw mdx HTML for one entry into a structured dict.

    Returns None if the entry has no usable senses (we skip those — they're
    usually pure cross-ref stubs already filtered out upstream).
    """
    senses = _extract_senses(html_str)
    if not senses:
        return None
    out: dict = {"lemma": lemma, "senses": senses}
    phon = _extract_phonetics(html_str)
    if phon:
        out["phon"] = phon
    phrases = _extract_phrases(lemma, html_str)
    if phrases:
        out["phrases"] = phrases
    return out


# ---------------------------------------------------------------------------
# Sharded JSON writer
# ---------------------------------------------------------------------------

# Lemmas we keep: pure ASCII letters (+ optional hyphen / apostrophe / space),
# 1–40 chars. We INCLUDE multi-word lemmas here because OALD has plenty of
# phrasal entries the user will look up ("a priori", "give up"), but length is
# capped so we don't pull idiom write-ups in as standalone keys.
_VALID_LEMMA = re.compile(r"^[A-Za-z][A-Za-z\-\'\s]{0,40}$")


def _shard_key(lemma: str) -> str:
    c = lemma[:1].lower()
    return c if "a" <= c <= "z" else "other"


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    mdx = repo_root / "牛津高阶英汉词典" / "牛津高阶英汉双解词典（第9版）.mdx"
    out_dir = repo_root / "web" / "public" / "dict"
    out_dir.mkdir(parents=True, exist_ok=True)

    if not mdx.exists():
        print(f"[error] mdx not found: {mdx}", file=sys.stderr)
        return 2

    print(f"[info] parsing {mdx} …")
    shards: dict = {}
    index: dict = {}
    link_count = 0
    skipped = 0
    total = 0
    no_senses = 0

    for lemma, raw_html in parse_mdx(mdx):
        total += 1
        if raw_html.startswith("@@@LINK="):
            link_count += 1
            continue
        if not _VALID_LEMMA.match(lemma):
            skipped += 1
            continue
        key_lc = lemma.strip().lower()
        if not key_lc:
            skipped += 1
            continue
        entry = extract_entry(key_lc, raw_html)
        if entry is None:
            no_senses += 1
            continue
        shard = _shard_key(key_lc)
        shards.setdefault(shard, {})
        existing = shards[shard].get(key_lc)
        if existing is None or len(entry["senses"]) > len(existing["senses"]):
            shards[shard][key_lc] = entry
            index[key_lc] = shard

    # second pass: cross-refs (@@@LINK=target) → alias entries
    print("[info] resolving cross-refs …")
    resolved = 0
    for lemma, raw_html in parse_mdx(mdx):
        if not raw_html.startswith("@@@LINK="):
            continue
        target = raw_html[len("@@@LINK="):].strip().rstrip("\x00\r\n").lower()
        if not _VALID_LEMMA.match(lemma):
            continue
        key_lc = lemma.strip().lower()
        if not key_lc or key_lc in index:
            continue
        target_shard = index.get(target)
        if target_shard is None:
            continue
        target_entry = shards[target_shard].get(target)
        if target_entry is None:
            continue
        shard = _shard_key(key_lc)
        shards.setdefault(shard, {})
        # alias: just record where to redirect; the UI will fetch target.
        shards[shard][key_lc] = {
            "lemma": key_lc,
            "alias_of": target,
        }
        index[key_lc] = shard
        resolved += 1

    # write shards
    total_bytes = 0
    for shard, entries in sorted(shards.items()):
        out_path = out_dir / f"dictionary-{shard}.json"
        with out_path.open("w", encoding="utf-8") as fp:
            json.dump(entries, fp, ensure_ascii=False, separators=(",", ":"))
        size = out_path.stat().st_size
        total_bytes += size
        print(f"[info] wrote {out_path.name}: {len(entries)} entries "
              f"({size / 1024:.0f} KB)")

    with (out_dir / "dictionary-index.json").open("w", encoding="utf-8") as fp:
        json.dump(index, fp, ensure_ascii=False, separators=(",", ":"))
    print(f"[info] wrote dictionary-index.json: {len(index)} keys")

    # Sorted lemma list for prefix-suggestion. Plain JSON array is enough; the
    # browser does the prefix scan in JS — at 195k entries this is fine.
    lemmas = sorted(index.keys())
    with (out_dir / "lemma-list.json").open("w", encoding="utf-8") as fp:
        json.dump(lemmas, fp, ensure_ascii=False, separators=(",", ":"))
    print(f"[info] wrote lemma-list.json: {len(lemmas)} keys "
          f"({(out_dir / 'lemma-list.json').stat().st_size / 1024:.0f} KB)")

    print(f"[done] mdx entries={total} links={link_count} resolved={resolved} "
          f"skipped={skipped} no_senses={no_senses} "
          f"total_size={total_bytes / 1024 / 1024:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
