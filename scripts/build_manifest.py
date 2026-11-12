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

from whitelist import load_whitelist_text, parse_whitelist, is_whitelisted, is_private, \
    parse_share_list, load_optional_text

OUTPUT_FILE = "public/manifest.json"
SHARES_DIR = "public/shares"
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".manifest_cache.json")
PUBLISH_TAG = "public"  # kept for cache compat; whitelist file is authoritative now
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".heic")
SCAN_PREFIX = "media/kepek/Saját képek/"
WEB_ARCHIVE = "media/_web-archive/"
WHITELIST_KEY = WEB_ARCHIVE + "lists/public-list.txt"
SHARE_LIST_KEY = WEB_ARCHIVE + "lists/share-list.txt"
HEAD_BYTES = 262144  # 256 KB covers EXIF + IPTC segments of any X100V JPEG
EXIFTOOL_FIELDS = ["-DateTimeOriginal", "-CreateDate", "-DateTime", "-Keywords",
                   "-Subject", "-XPKeywords", "-ImageWidth", "-ImageHeight"]

BUCKET = "tb1"
PREFIX_TRIM = len("media/")

def load_whitelist(s3):
    try:
        rules = parse_whitelist(load_whitelist_text(s3, BUCKET, WHITELIST_KEY))
    except Exception as e:
        # The whitelist is authoritative — never build/publish an empty
        # manifest just because S3 hiccuped; abort and leave outputs alone.
        print(f"❌ public-list.txt fetch failed ({e}) — aborting, outputs untouched")
        sys.exit(1)
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


def ensure_probed(s3, obj, cache, fetched_ref):
    """Probe one file through the cache; returns the metadata record.
    fetched_ref: [fetched_counter, reused_counter] (mutated in place)."""
    ckey = f"{obj['key']}|{obj['size']}|{obj['etag']}"
    rec = cache.get(ckey)
    if rec and (rec.get("dt") or rec.get("attempts", 0) >= 3):
        fetched_ref[1] += 1
        return rec
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
    fetched_ref[0] += 1
    return rec


def resolve_dt(rec, rel_key, counters):
    """EXIF date -> manifest record; falls back to the date-prefixed folder
    name when EXIF carries no date. Mutates counters dict."""
    if not rec.get("dt"):
        m = re.search(r"\d{4}-\d{2}-\d{2}", rel_key)
        if m:
            try:
                rec = {**rec, "dt": datetime.strptime(m.group(0), "%Y-%m-%d").strftime("%Y:%m:%d 00:00:00")}
                counters["pathdated"] += 1
            except ValueError:
                pass
    if not rec.get("dt"):
        counters["untagged"] += 1
        return None
    try:
        return datetime.strptime(str(rec["dt"])[:19], "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None


def build_shares(s3, all_images, cache, fetched_ref):
    """Build public/shares/<slug>.json for every folder in share-list.txt.
    Unlisted on the landing site; each folder becomes one slug page."""
    share_text = None
    try:
        share_text = load_optional_text(s3, BUCKET, SHARE_LIST_KEY)
    except Exception as e:
        print(f"⚠️ share-list.txt fetch failed ({e}) — leaving existing share files untouched")
    if share_text is None:
        return {"untagged": 0, "pathdated": 0}
    share_rules = parse_share_list(share_text)
    print(f"Share list: {len(share_rules)} shared folder(s)")
    os.makedirs(SHARES_DIR, exist_ok=True)

    counters = {"untagged": 0, "pathdated": 0}
    index = {}
    for slug, rule in share_rules:
        targets = [o for o in all_images
                   if is_whitelisted(o["key"][len(SCAN_PREFIX):], [rule])
                   and not is_private(o["key"][len(SCAN_PREFIX):])]
        photos = []
        for obj in targets:
            rel = obj["key"][len(SCAN_PREFIX):]
            rec = ensure_probed(s3, obj, cache, fetched_ref)
            if fetched_ref[0] % 25 == 0:
                with open(CACHE_FILE, "w") as f:
                    json.dump(cache, f)
            dt = resolve_dt(rec, rel, counters)
            if dt is None:
                continue
            photos.append({
                "key": obj["key"][PREFIX_TRIM:],
                "name": os.path.basename(obj["key"]),
                "time": dt.isoformat(),
                "width": rec["width"],
                "height": rec["height"],
            })
        photos.sort(key=lambda p: p["time"])
        with open(os.path.join(SHARES_DIR, f"{slug}.json"), "w") as f:
            json.dump({"slug": slug, "folder": rule, "photos": photos}, f, indent=2)
        index[slug] = {"folder": rule, "photos": len(photos)}
        print(f"  /s/{slug}: {rule} -> {len(photos)} photo(s)")

    # drop share pages whose folder left the list
    for fn in os.listdir(SHARES_DIR):
        if fn.endswith(".json") and fn != "index.json" and fn[:-5] not in index:
            os.remove(os.path.join(SHARES_DIR, fn))
            print(f"removed stale share file {fn}")
    with open(os.path.join(SHARES_DIR, "index.json"), "w") as f:
        json.dump(index, f, indent=2)
    return counters


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
    fetched_ref = [0, 0]  # [fetched, reused]
    untagged = pathdated = 0
    public_n = 0

    for i, obj in enumerate(images):
        rec = ensure_probed(s3, obj, cache, fetched_ref)
        fetched, reused = fetched_ref
        if fetched and fetched % 25 == 0:
            print(f"  {i + 1}/{len(images)} (fetched {fetched}, cached {reused})")
            with open(CACHE_FILE, "w") as f:
                json.dump(cache, f)

        counters = {"untagged": 0, "pathdated": 0}
        dt = resolve_dt(rec, obj["key"][len(SCAN_PREFIX):], counters)
        untagged += counters["untagged"]
        pathdated += counters["pathdated"]
        if dt is None:
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

    # Unlisted share pages: public/shares/<slug>.json from share-list.txt
    share_counters = build_shares(s3, all_images, cache, fetched_ref)
    untagged += share_counters["untagged"]
    pathdated += share_counters["pathdated"]

    with open(CACHE_FILE, "w") as f:
        json.dump(cache, f)
    fetched, reused = fetched_ref
    print(f"Fetched {fetched} new / reused {reused} cached | {untagged} untagged | "
          f"{pathdated} folder-dated | manifest: {len(manifest['years'])} yr(s), {public_n} public photos.")


if __name__ == "__main__":
    main()
