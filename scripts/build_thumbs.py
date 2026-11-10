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
                       is_private, parse_share_list, get_s3_client)

try:
    # iOS HEIC sources: decode via libheif so thumbs + JPEG fulls can build
    from pillow_heif import register_heif_opener
    register_heif_opener()
    HEIC_OK = True
except ImportError:
    HEIC_OK = False

THUMB_LONG_SIDE = 640
THUMB_QUALITY = 72
FULL_LONG_SIDE = 2560   # JPEG rendition for HEIC originals (browsers can't decode HEIC)
FULL_QUALITY = 85
SCAN_PREFIX = "media/kepek/Saját képek/"
THUMB_PREFIX = "media/thumbs/"
FULL_PREFIX = "media/fulls/"
KEY_VERSION = "v2"  # bump when thumb params change — old-state entries rebuild
WHITELIST_KEY = SCAN_PREFIX + "public-list.txt"
SHARE_LIST_KEY = SCAN_PREFIX + "share-list.txt"
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
    # share-list.txt folders are NOT on the landing site but need thumbs (and
    # HEIC fulls) too — else the stale-sweep below would delete their thumbs.
    share_rules = parse_share_list(load_whitelist_text(s3, BUCKET, SHARE_LIST_KEY))
    out = []
    pag = s3.get_paginator("list_objects_v2")
    for page in pag.paginate(Bucket=BUCKET, Prefix=SCAN_PREFIX):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if os.path.splitext(key)[1].lower() not in IMAGE_EXTS:
                continue
            rel = key[len(SCAN_PREFIX):]
            if is_private(rel):
                continue
            in_public = is_whitelisted(rel, rules)
            in_share = any(is_whitelisted(rel, [rule]) for _s, rule in share_rules)
            if not in_public and not in_share:
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


def is_heic(key: str) -> bool:
    return key.lower().endswith((".heic", ".heif"))


def make_full(data: bytes) -> bytes:
    """Browser-displayable JPEG rendition (for HEIC originals)."""
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im)
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    im.thumbnail((FULL_LONG_SIDE, FULL_LONG_SIDE), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=FULL_QUALITY, optimize=True, progressive=True)
    return buf.getvalue()


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else None
    s3 = get_s3_client()
    state = load_state()

    items = current_items(s3)
    if not HEIC_OK:
        items = [it for it in items if not is_heic(it["key"])]
    # Thumb key mirrors the original *below* media/: thumbs/<rel-to-media/>
    thumb_keys = {THUMB_PREFIX + it["key"][len("media/"):] for it in items}
    full_keys = {FULL_PREFIX + it["key"][len("media/"):] + ".jpg" for it in items if is_heic(it["key"])}
    live_keys = {it["key"] for it in items}

    pending = [it for it in items
               if state.get(f"{it['key']}|{it['size']}|{it['etag']}|{KEY_VERSION}") is not True]
    if limit:
        pending = pending[:limit]
    heic_n = sum(1 for it in items if is_heic(it["key"]))
    print(f"{len(items)} publishable images ({heic_n} heic), {len(pending)} thumbs to build", flush=True)

    done = 0
    for it in items:
        ckey = f"{it['key']}|{it['size']}|{it['etag']}|{KEY_VERSION}"
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
            # HEIC originals can't display in browsers — publish a JPEG full
            if is_heic(it["key"]):
                s3.put_object(Bucket=BUCKET,
                              Key=FULL_PREFIX + it["key"][len("media/"):] + ".jpg",
                              Body=make_full(data), ContentType="image/jpeg",
                              CacheControl="public, max-age=31536000, immutable")
            state[ckey] = True
            done += 1
            if done % 25 == 0:
                with open(STATE_FILE, "w") as f:
                    json.dump(state, f)
                print(f"  {done}/{len(pending)}", flush=True)
        except Exception as e:
            print(f"  skip {it['key']}: {e}", flush=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)

    # Sweep thumbs and HEIC fulls whose original is gone/renamed/private —
    # privacy-critical.
    stale = []
    pag = s3.get_paginator("list_objects_v2")
    for prefix, allowed in ((THUMB_PREFIX, thumb_keys), (FULL_PREFIX, full_keys)):
        for page in pag.paginate(Bucket=BUCKET, Prefix=prefix):
            for obj in page.get("Contents", []):
                if obj["Key"] not in allowed:
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
