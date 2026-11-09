#!/usr/bin/env python3
"""
Build public/manifest.json from the TB1 MinIO bucket -- ZERO disk downloads.

Strategy (light, session-crash-proof):
  - list objects under SCAN_PREFIX
  - for each image, ranged GET of only the first HEAD_BYTES bytes
    (EXIF/IPTC metadata lives in the JPEG header segments at the start)
  - feed those bytes to exiftool via STDIN -- no temp files, no tmp dirs
  - cache results in scripts/.manifest_cache.json keyed by (size, etag),
    so reruns never re-fetch unchanged files
Only images with keyword "public" are included (whitelist).

Usage: python3 build_manifest.py [N]   # N = scan first N files (test mode)
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime

import boto3

from whitelist import load_whitelist_text, parse_whitelist, is_whitelisted, is_private

OUTPUT_FILE = "public/manifest.json"
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".manifest_cache.json")
PUBLISH_TAG = "public"  # kept for cache compat; whitelist file is authoritative now
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".heic")
SCAN_PREFIX = "media/kepek/Saját képek/"
WHITELIST_KEY = SCAN_PREFIX + "public-list.txt"
HEAD_BYTES = 262144  # 256 KB covers EXIF + IPTC segments of any X100V JPEG
EXIFTOOL_FIELDS = ["-DateTimeOriginal", "-CreateDate", "-DateTime", "-Keywords",
                   "-Subject", "-XPKeywords", "-ImageWidth", "-ImageHeight"]

BUCKET = "tb1"
PREFIX_TRIM = len("media/")

def load_whitelist(s3):
    rules = parse_whitelist(load_whitelist_text(s3, BUCKET, WHITELIST_KEY))
    print(f"Whitelist: {len(rules)} rule(s)")
    return rules


def get_s3_client():
    """Read credentials from ~/.mc/config.json (tb1 alias)."""
    cfg_path = os.path.expanduser("~/.mc/config.json")
    with open(cfg_path) as f:
        cfg = json.load(f)
    alias = cfg["aliases"]["tb1"]
    return boto3.client(
        "s3",
        endpoint_url=alias["url"],
        aws_access_key_id=alias["accessKey"],
        aws_secret_access_key=alias["secretKey"],
        region_name=alias.get("region", "us-east-1"),
        config=boto3.session.Config(s3={"addressing_style": "path"}),
    )


def list_s3_images(s3, limit=None):
    imgs = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET, Prefix=SCAN_PREFIX):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if os.path.splitext(key)[1].lower() in IMAGE_EXTS:
                imgs.append({"key": key, "size": obj["Size"], "etag": obj["ETag"]})
                if limit and len(imgs) >= limit:
                    return imgs
    return imgs


def probe(s3, key):
    """Fetch metadata header bytes and run exiftool on them via stdin."""
    resp = s3.get_object(Bucket=BUCKET, Key=key, Range=f"bytes=0-{HEAD_BYTES - 1}")
    head = resp["Body"].read()
    res = subprocess.run(
        ["exiftool", "-j", "-n", *EXIFTOOL_FIELDS, "-"],
        input=head, capture_output=True, timeout=30,
    )
    out = res.stdout.decode("utf-8", errors="replace").strip()
    if not out:
        return {"dt": None, "keywords": [], "width": None, "height": None}
    rec = json.loads(out)[0]
    kws = []
    for field in ("Keywords", "Subject", "XPKeywords"):
        v = rec.get(field)
        if v is None:
            continue
        if isinstance(v, list):
            kws.extend(str(t) for t in v)
        else:
            kws.extend(t.strip() for t in str(v).replace(";", ",").split(",") if t.strip())
    dt = rec.get("DateTimeOriginal") or rec.get("CreateDate") or rec.get("DateTime")
    return {"dt": dt, "keywords": [k.lower() for k in kws],
            "width": rec.get("ImageWidth"), "height": rec.get("ImageHeight")}


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else None  # test mode

    s3 = get_s3_client()
    rules = load_whitelist(s3)
    cache = {}
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE) as f:
                cache = json.load(f)
        except (ValueError, OSError):
            cache = {}

    all_images = list_s3_images(s3, limit)
    priv_n = 0
    whitelisted = []
    for o in all_images:
        if not is_whitelisted(o["key"][len(SCAN_PREFIX):], rules):
            continue
        if is_private(o["key"][len(SCAN_PREFIX):]):
            priv_n += 1  # private marker: folder/title with dot+p -> never published
            continue
        whitelisted.append(o)
    images = whitelisted
    print(f"{len(all_images)} images under {SCAN_PREFIX}, {len(images)} whitelisted, "
          f"{priv_n} .p-private excluded")

    manifest = {"years": {}}
    fetched = reused = public_n = untagged = pathdated = 0

    for i, obj in enumerate(images):
        ckey = f"{obj['key']}|{obj['size']}|{obj['etag']}"
        rec = cache.get(ckey)
        if rec and (rec.get("dt") or rec.get("attempts", 0) >= 3):
            reused += 1
        else:
            # Transient S3/exiftool failures (e.g. right after a rename) must
            # not poison the cache forever: retry no-date records a few times.
            try:
                rec = probe(s3, obj["key"])
            except Exception as e:
                print(f"  skip {obj['key']}: {e}")
                rec = {"dt": None, "keywords": [], "width": None, "height": None}
            if not rec.get("dt"):
                rec["attempts"] = (rec.get("attempts") or (cache.get(ckey) or {}).get("attempts", 0) or 0) + 1
            else:
                rec.pop("attempts", None)
            cache[ckey] = rec
            fetched += 1
            if fetched % 25 == 0:
                print(f"  {i + 1}/{len(images)} (fetched {fetched}, cached {reused})")
                # persist cache incrementally so a kill loses nothing
                with open(CACHE_FILE, "w") as f:
                    json.dump(cache, f)

        # EXIF may be absent (e.g. Panasonic JPEGs without any date tag);
        # folders in this bucket are date-prefixed -> fall back to that.
        if not rec.get("dt"):
            m = re.search(r"\d{4}-\d{2}-\d{2}", obj["key"][len(SCAN_PREFIX):])
            if m:
                try:
                    rec = {**rec, "dt": datetime.strptime(m.group(0), "%Y-%m-%d").strftime("%Y:%m:%d 00:00:00")}
                    cache[ckey] = rec
                    pathdated += 1
                except ValueError:
                    pass
        if not rec.get("dt"):
            untagged += 1
            continue
        try:
            dt = datetime.strptime(str(rec["dt"])[:19], "%Y:%m:%d %H:%M:%S")
        except ValueError:
            continue

        public_n += 1
        year, day = str(dt.year), dt.strftime("%Y-%m-%d")
        manifest["years"].setdefault(year, {}).setdefault(day, []).append({
            "key": obj["key"][PREFIX_TRIM:],
            "name": os.path.basename(obj["key"]),
            "time": dt.isoformat(),
            "width": rec["width"],
            "height": rec["height"],
        })

    manifest["years"] = dict(sorted(manifest["years"].items(), reverse=True))
    for y in manifest["years"]:
        manifest["years"][y] = dict(sorted(manifest["years"][y].items(), reverse=True))

    os.makedirs(os.path.dirname(os.path.abspath(OUTPUT_FILE)), exist_ok=True)
    with open(OUTPUT_FILE, "w") as f:
        json.dump(manifest, f, indent=2)
    with open(CACHE_FILE, "w") as f:
        json.dump(cache, f)
    print(f"Fetched {fetched} new / reused {reused} cached | {untagged} untagged | "
          f"{pathdated} folder-dated | manifest: {len(manifest['years'])} yr(s), {public_n} public photos.")


if __name__ == "__main__":
    main()
