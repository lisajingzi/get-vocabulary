#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Upload the extracted dictionary images to Tencent COS under `/dict/images/*`.

Idempotent: HEAD each object first and skip anything already present with a
matching content-length. Safe to re-run after `extract_mdd.py`.

Credentials come from `web/.env.local` (same file the Next.js app reads):

    COS_SECRET_ID=…
    COS_SECRET_KEY=…
    COS_BUCKET=your-bucket-1234567890
    COS_REGION=ap-guangzhou

The bucket must allow public read on `/dict/images/*` (either bucket-wide
public-read or a policy). Each object is uploaded with `x-cos-acl:
public-read` so it stays fetchable even on a private bucket.

Usage:
    python3 scripts/upload_dict_images.py [--concurrency 8] [--force]
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import hmac
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# .env.local loader (tiny, zero-dep — matches Next.js behaviour well enough)
# ---------------------------------------------------------------------------

def _load_env(env_path: Path) -> dict:
    env: dict = {}
    if not env_path.exists():
        return env
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        # Strip surrounding quotes if any
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
            v = v[1:-1]
        env[k.strip()] = v
    return env


# ---------------------------------------------------------------------------
# COS signing (mirrors web/src/app/api/cos/sync/route.ts:cosSign)
# ---------------------------------------------------------------------------

def _cos_sign(
    secret_id: str,
    secret_key: str,
    method: str,
    path: str,
    query: Optional[dict] = None,
) -> str:
    query = query or {}
    now = int(time.time())
    expire = now + 900  # 15 min
    key_time = f"{now};{expire}"

    sign_key = hmac.new(
        secret_key.encode(), key_time.encode(), hashlib.sha1
    ).hexdigest()

    sorted_params = "&".join(
        f"{k.lower()}={urllib.parse.quote(str(v), safe='')}"
        for k, v in sorted(query.items())
    )
    http_string = f"{method.lower()}\n{path}\n{sorted_params}\n\n"
    sha1_hash = hashlib.sha1(http_string.encode()).hexdigest()
    string_to_sign = f"sha1\n{key_time}\n{sha1_hash}\n"
    signature = hmac.new(
        sign_key.encode(), string_to_sign.encode(), hashlib.sha1
    ).hexdigest()
    param_list = ";".join(sorted(k.lower() for k in query))

    return (
        f"q-sign-algorithm=sha1"
        f"&q-ak={secret_id}"
        f"&q-sign-time={key_time}"
        f"&q-key-time={key_time}"
        f"&q-header-list="
        f"&q-url-param-list={param_list}"
        f"&q-signature={signature}"
    )


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _cos_url(bucket: str, region: str, path: str) -> str:
    return f"https://{bucket}.cos.{region}.myqcloud.com{path}"


def _head(url: str, auth: str, timeout: float = 10.0) -> Optional[int]:
    """Return content-length if the object exists, else None."""
    req = urllib.request.Request(url, method="HEAD",
                                 headers={"Authorization": auth})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            cl = resp.headers.get("Content-Length")
            return int(cl) if cl is not None else 0
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        # Any other error: treat as "unknown" — force re-upload to be safe.
        return None
    except Exception:
        return None


def _put(url: str, auth: str, body: bytes, timeout: float = 60.0) -> None:
    req = urllib.request.Request(
        url,
        method="PUT",
        data=body,
        headers={
            "Authorization": auth,
            "Content-Type": "image/jpeg",
            "Content-Length": str(len(body)),
            "x-cos-acl": "public-read",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        if resp.status // 100 != 2:
            raise RuntimeError(
                f"COS PUT {url} failed: {resp.status} {resp.reason}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--concurrency", type=int, default=8,
                        help="parallel uploads (default 8)")
    parser.add_argument("--force", action="store_true",
                        help="re-upload even if object already exists")
    parser.add_argument("--prefix", default="/dict/images",
                        help="COS key prefix (default /dict/images)")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    env = _load_env(repo_root / "web" / ".env.local")
    secret_id = env.get("COS_SECRET_ID") or os.environ.get("COS_SECRET_ID", "")
    secret_key = env.get("COS_SECRET_KEY") or os.environ.get("COS_SECRET_KEY", "")
    bucket = env.get("COS_BUCKET") or os.environ.get("COS_BUCKET", "")
    region = env.get("COS_REGION") or os.environ.get("COS_REGION", "ap-guangzhou")

    if not (secret_id and secret_key and bucket):
        print("[error] COS credentials missing — set COS_SECRET_ID / "
              "COS_SECRET_KEY / COS_BUCKET in web/.env.local",
              file=sys.stderr)
        return 2

    src_dir = repo_root / "scripts" / ".dict-images"
    files = sorted(p for p in src_dir.iterdir() if p.is_file())
    if not files:
        print(f"[error] no images to upload in {src_dir} — "
              f"run scripts/extract_mdd.py first",
              file=sys.stderr)
        return 2
    print(f"[info] uploading {len(files)} images to "
          f"cos://{bucket}{args.prefix}/ (region={region})")

    uploaded = 0
    skipped = 0
    failed = 0
    total_bytes = 0

    def _work(fp: Path) -> tuple[str, str]:
        nonlocal uploaded, skipped, failed, total_bytes
        path = f"{args.prefix}/{fp.name}"
        url = _cos_url(bucket, region, path)
        body = fp.read_bytes()

        if not args.force:
            head_auth = _cos_sign(secret_id, secret_key, "head", path)
            existing = _head(url, head_auth)
            if existing is not None and existing == len(body):
                return fp.name, "skip"

        put_auth = _cos_sign(secret_id, secret_key, "put", path)
        _put(url, put_auth, body)
        total_bytes += len(body)
        return fp.name, "put"

    with cf.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = {pool.submit(_work, fp): fp for fp in files}
        for i, fut in enumerate(cf.as_completed(futures), 1):
            fp = futures[fut]
            try:
                _name, status = fut.result()
                if status == "put":
                    uploaded += 1
                else:
                    skipped += 1
            except Exception as e:
                failed += 1
                print(f"[error] {fp.name}: {e}", file=sys.stderr)
            if i % 50 == 0 or i == len(files):
                print(f"[info] progress {i}/{len(files)} "
                      f"(uploaded={uploaded} skipped={skipped} failed={failed})")

    print(f"[done] uploaded={uploaded} skipped={skipped} failed={failed} "
          f"bytes_sent={total_bytes / 1024 / 1024:.1f} MB")
    if uploaded > 0:
        sample = files[0].name
        print(f"[info] sample public URL: "
              f"https://{bucket}.cos.{region}.myqcloud.com"
              f"{args.prefix}/{sample}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
