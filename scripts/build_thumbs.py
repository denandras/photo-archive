#!/usr/bin/env python3
"""
Generate small WebP thumbnails for every publishable image into the bucket.

Thumb key mirrors the original: media/thumbs/<original-key-rel-to-media/>.
State: .thumbs_cache.json {original ckey -> True}; only new/changed (size,etag)
originals are processed. Stale thumbs (original renamed, removed, or marked
private ".p") are deleted, so private items never keep a public thumbnail.

Cheap after first run: LAN downloads from the local MinIO, incremental cache.
Usage: python3 build_thumbs.py [N]   # N = process first N pending (test mode)
"""
import io
import json
import os
import sys

from PIL import Image, ImageOps

# Own camera files (incl. large panoramas) — no decompression-bomb cap needed.
Image.MAX_IMAGE_PIXELS = None

from whitelist import (load_whitelist_text, parse_whitelist, is_whitelisted,
                       is_private, get_s3_client)

THUMB_LONG_SIDE = 640
THUMB_QUALITY = 72
SCAN_PREFIX = "media/kepek/Saját képek/"
THUMB_PREFIX = "media/thumbs/"
WHITELIST_KEY = SCAN_PREFIX + "public-list.txt"
STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".thumbs_cache.json")
BUCKET = "tb1"
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".heic")


def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f:
                return json.load(f)
        except (ValueError, OSError):
            pass
    return {}


def current_items(s3):
    rules = parse_whitelist(load_whitelist_text(s3, BUCKET, WHITELIST_KEY))
    out = []
    pag = s3.get_paginator("list_objects_v2")
    for page in pag.paginate(Bucket=BUCKET, Prefix=SCAN_PREFIX):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if os.path.splitext(key)[1].lower() not in IMAGE_EXTS:
                continue
            rel = key[len(SCAN_PREFIX):]
            if not is_whitelisted(rel, rules) or is_private(rel):
                continue
            out.append({"key": key, "size": obj["Size"], "etag": obj["ETag"]})
    return out


def make_thumb(data: bytes) -> bytes:
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im)
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    im.thumbnail((THUMB_LONG_SIDE, THUMB_LONG_SIDE), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=THUMB_QUALITY, method=5)
    return buf.getvalue()


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else None
    s3 = get_s3_client()
    state = load_state()

    items = current_items(s3)
    # Thumb key mirrors the original *below* media/: thumbs/<rel-to-media/>
    thumb_keys = {THUMB_PREFIX + it["key"][len("media/"):] for it in items}
    live_keys = {it["key"] for it in items}

    pending = [it for it in items
               if state.get(f"{it['key']}|{it['size']}|{it['etag']}") is not True]
    if limit:
        pending = pending[:limit]
    print(f"{len(items)} publishable images, {len(pending)} thumbs to build")

    done = 0
    for it in items:
        ckey = f"{it['key']}|{it['size']}|{it['etag']}"
        if state.get(ckey) is True:
            continue
        try:
            resp = s3.get_object(Bucket=BUCKET, Key=it["key"])
            data = resp["Body"].read()
            webp = make_thumb(data)
            thumb_key = THUMB_PREFIX + it["key"][len("media/"):]
            s3.put_object(Bucket=BUCKET, Key=thumb_key, Body=webp,
                          ContentType="image/webp",
                          CacheControl="public, max-age=31536000, immutable")
            state[ckey] = True
            done += 1
            if done % 25 == 0:
                with open(STATE_FILE, "w") as f:
                    json.dump(state, f)
                print(f"  {done}/{len(pending)}")
        except Exception as e:
            print(f"  skip {it['key']}: {e}")
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)

    # Sweep thumbs whose original is gone/renamed/private — privacy-critical.
    stale = []
    pag = s3.get_paginator("list_objects_v2")
    for page in pag.paginate(Bucket=BUCKET, Prefix=THUMB_PREFIX):
        for obj in page.get("Contents", []):
            if obj["Key"] not in thumb_keys:
                stale.append(obj["Key"])
    for key in stale:
        try:
            s3.delete_object(Bucket=BUCKET, Key=key)
        except Exception as e:
            print(f"  stale delete failed {key}: {e}")
    if stale:
        print(f"Removed {len(stale)} stale thumb(s)")

    # Prune state entries whose original key is no longer publishable.
    pruned = {k: v for k, v in state.items()
              if k.split("|", 1)[0] in live_keys}
    with open(STATE_FILE, "w") as f:
        json.dump(pruned, f)

    print(f"Thumbs: {done} built now, {len(thumb_keys)} live")


if __name__ == "__main__":
    main()
