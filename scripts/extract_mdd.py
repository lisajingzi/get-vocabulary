#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Extract the image assets referenced by the Oxford 9 dictionary out of the
companion `.mdd` container into a flat local folder.

The mdd file has the same container layout as the mdx (KEY / RECORD blocks,
zlib-compressed), the only difference being that record payloads are raw
binary files (jpg / svg / etc.) instead of HTML strings. We reuse the mdx
reader helpers from `parse_mdx.py`.

Output: files are written to `scripts/.dict-images/<basename>`.
        Only images actually referenced by an entry (via `sense.img.thumb`
        or `sense.img.big` in the parsed shard JSON) are kept — this drops
        the ~40 orphan assets in the mdd and skips the css/js/ttf too.

Usage:
    python3 scripts/extract_mdd.py

The output directory is git-ignored (see .gitignore) — it's a build artefact,
not source. Uploading to COS happens in a separate step
(`scripts/upload_dict_images.py`).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# Reuse the mdx binary reader — mdd shares the exact same container format.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from parse_mdx import (  # type: ignore  # noqa: E402
    _read_header, _iter_keys, _read_records,
)


def _collect_referenced_images(dict_dir: Path) -> set[str]:
    """Scan the shard JSONs and return every image filename we actually need."""
    wanted: set[str] = set()
    for shard in sorted(dict_dir.glob("dictionary-*.json")):
        if shard.name == "dictionary-index.json":
            continue
        with shard.open("r", encoding="utf-8") as fp:
            data = json.load(fp)
        for entry in data.values():
            for s in entry.get("senses", []) or []:
                img = s.get("img")
                if not img:
                    continue
                if "thumb" in img:
                    wanted.add(img["thumb"])
                if "big" in img:
                    wanted.add(img["big"])
    return wanted


def _iter_mdd_records(mdd_path: Path):
    """Yield (filename, bytes) for every resource in the mdd."""
    with mdd_path.open("rb") as f:
        attrs = _read_header(f)
        version = float(attrs.get("GeneratedByEngineVersion", "2.0"))
        # mdd headers usually say Encoding="", but the KEY section still uses
        # UTF-16 for filenames — matching the mdx v2 layout.
        encoding = attrs.get("Encoding") or "UTF-16"
        keys = list(_iter_keys(f, version, encoding))
        blob = _read_records(f, version)

    keys_sorted = sorted(set(keys), key=lambda kv: kv[0])
    for i, (offset, key) in enumerate(keys_sorted):
        end = keys_sorted[i + 1][0] if i + 1 < len(keys_sorted) else len(blob)
        # mdd stores paths like "\\thumb_ant.jpg" (Windows-style, leading
        # backslash). Normalise to a plain basename so it lines up with the
        # `img` values we emitted in parse_mdx.
        name = os.path.basename(key.replace("\\", "/")).strip()
        yield name, bytes(blob[offset:end])


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    mdd = repo_root / "牛津高阶英汉词典" / "牛津高阶英汉双解词典（第9版）.mdd"
    dict_dir = repo_root / "web" / "public" / "dict"
    out_dir = repo_root / "scripts" / ".dict-images"
    out_dir.mkdir(parents=True, exist_ok=True)

    if not mdd.exists():
        print(f"[error] mdd not found: {mdd}", file=sys.stderr)
        return 2
    if not dict_dir.exists():
        print(f"[error] dictionary shards not found: {dict_dir}\n"
              f"        run scripts/parse_mdx.py first",
              file=sys.stderr)
        return 2

    wanted = _collect_referenced_images(dict_dir)
    print(f"[info] shards reference {len(wanted)} unique image files")
    # Match case-insensitively — mdd filenames sometimes vary in case.
    wanted_lc = {n.lower(): n for n in wanted}

    written = 0
    skipped = 0
    total_bytes = 0
    for name, payload in _iter_mdd_records(mdd):
        lc = name.lower()
        # Only keep files we actually reference from the JSON. This drops
        # css/js/ttf and a small number of orphan images that no entry uses.
        if lc not in wanted_lc:
            skipped += 1
            continue
        # Preserve the canonical spelling used in the JSON so URL lookups match.
        out_name = wanted_lc[lc]
        (out_dir / out_name).write_bytes(payload)
        written += 1
        total_bytes += len(payload)

    print(f"[done] wrote {written} images to {out_dir} "
          f"({total_bytes / 1024 / 1024:.1f} MB); "
          f"skipped {skipped} non-referenced records")
    missing = set(wanted_lc) - {n.lower() for n in os.listdir(out_dir)}
    if missing:
        print(f"[warn] {len(missing)} referenced images were NOT found in "
              f"the mdd (first 5: {list(missing)[:5]})",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
