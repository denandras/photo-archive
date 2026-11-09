#!/usr/bin/env python3
"""
Split the probe cache into per-year manifest files + an index.

Reads scripts/.manifest_cache.json (key|size|etag -> {dt, keywords, w, h})
and the S3 listing, and writes:

  public/years/<year>.json        {"days": {<YYYY-MM-DD>: [photo,...]}}
  public/manifest.index.json      {"years": {<year>: {"days": N, "photos": M}}}

Cheap: no S3 metadata fetches beyond listing. Re-run any time (after
build_manifest.py probes new files) to refresh the affected years only.
"""
import json
import os
import sys
from datetime import datetime

import boto3

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_FILE = os.path.join(PROJECT, "scripts", ".manifest_cache.json")
YEARS_DIR = os.path.join(PROJECT, "public", "years")
INDEX_FILE = os.path.join(PROJECT, "public", "manifest.index.json")
PUBLISH_TAG = "public"
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".heic")
SCAN_PREFIX = "media/kepek/Saját képek/"
PREFIX_TRIM = len("media/")
BUCKET = "tb1"


def get_s3_client():
    with open(os.path.expanduser("~/.mc/config.json")) as f:
        alias = json.load(f)["aliases"]["tb1"]
    return boto3.client(
        "s3",
        endpoint_url=alias["url"],
        aws_access_key_id=alias["accessKey"],
        aws_secret_access_key=alias["secretKey"],
        region_name=alias.get("region", "us-east-1"),
        config=boto3.session.Config(s3={"addressing_style": "path"}),
    )


def main():
    only_year = sys.argv[1] if len(sys.argv) > 1 else None

    with open(CACHE_FILE) as f:
        cache = json.load(f)

    s3 = get_s3_client()
    from whitelist import load_whitelist_text, parse_whitelist, is_whitelisted
    rules = parse_whitelist(load_whitelist_text(s3, BUCKET, SCAN_PREFIX + "public-list.txt"))
    print(f"Whitelist: {len(rules)} rule(s)")

    years = {}  # year -> day -> [photo]
    index = {}
    touched = set()

    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET, Prefix=SCAN_PREFIX):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if os.path.splitext(key)[1].lower() not in IMAGE_EXTS:
                continue
            if not is_whitelisted(key[len(SCAN_PREFIX):], rules):
                continue
            ckey = f"{key}|{obj['Size']}|{obj['ETag']}"
            rec = cache.get(ckey)
            if not rec:
                continue  # not probed yet
            if not rec.get("dt"):
                continue
            try:
                dt = datetime.strptime(str(rec["dt"])[:19], "%Y:%m:%d %H:%M:%S")
            except ValueError:
                continue
            year = str(dt.year)
            if only_year and year != only_year:
                continue
            day = dt.strftime("%Y-%m-%d")
            years.setdefault(year, {}).setdefault(day, []).append({
                "key": key[PREFIX_TRIM:],
                "name": os.path.basename(key),
                "time": dt.isoformat(),
                "width": rec["width"],
                "height": rec["height"],
            })
            touched.add(year)

    os.makedirs(YEARS_DIR, exist_ok=True)
    # write every year found (cheap: cache-driven) so whitelist edits propagate,
    # and delete year files whose photos are all gone
    for y in list(years):
        days = years[y]
        for day in days:
            days[day].sort(key=lambda p: p["time"])
        with open(os.path.join(YEARS_DIR, f"{y}.json"), "w") as f:
            json.dump({"days": dict(sorted(days.items(), reverse=True))}, f)
        index[y] = {"days": len(days),
                    "photos": sum(len(v) for v in days.values())}

    for fn in os.listdir(YEARS_DIR):
        y = fn[:-5]
        if not fn.endswith(".json"):
            continue
        if y in index:
            continue
        os.remove(os.path.join(YEARS_DIR, fn))
        print(f"removed stale year file {fn}")

    index_out = dict(sorted(index.items(), key=lambda kv: int(kv[0]), reverse=True))
    with open(INDEX_FILE, "w") as f:
        json.dump(index_out, f)

    total = sum(v["photos"] for v in index_out.values())
    print(f"Wrote {len(index_out)} year files. Total public photos: {total}")

    if __import__("os").environ.get("DEBUG"):
        for y, v in list(index_out.items()):
            print(y, v)


if __name__ == "__main__":
    main()
