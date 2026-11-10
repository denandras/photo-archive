"""Shared whitelist logic for the photo manifest scripts.

The whitelist is a plain text file uploaded to S3 at:

    media/kepek/Sajat kepek root/  =  <SCAN_ROOT>public-list.txt

Format (UTF-8, one rule per line):
  - blank lines and lines starting with '#' are ignored
  - a line matches by prefix, so a name with no trailing slash covers the
    folder AND everything under it:  "2023 nyaralas"
  - a trailing '/' means folder-only:  "2023 nyaralas/"
  - a full filename matches just that file:  "IMG_20240101_113045.jpg"
"""

import io
import json
import os
import unicodedata
from datetime import datetime

import boto3
from botocore.exceptions import ClientError

# Image extensions whose trailing suffix must be stripped before the
# private-marker check (so "name.p.jpg" resolves to stem "name.p").
_IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".heic")


def _stem(name: str) -> str:
    low = name.lower()
    for ext in _IMAGE_EXTS:
        if low.endswith(ext):
            return name[: -len(ext)]
    return name


def is_private(key: str) -> bool:
    """A dot + LOWERCASE p on a title marks it private, never to reach the site:
    a folder "date.p" (everything under it) or a file "name.p[.jpg]".

    Case-sensitive: ".P" is NOT a private marker (per spec, small p only).
    """
    return any(_stem(part).endswith(".p") for part in key.split("/"))


def load_whitelist_text(s3, bucket: str, key: str) -> str:
    """Fetch a list file. RAISES on fetch failure — callers decide their
    fallback policy. Tolerating errors by returning "" here wiped all
    renditions once (empty whitelist -> empty publish set -> sweep deleted
    every HEIC thumb/full), so failing loudly is now the shared contract."""
    resp = s3.get_object(Bucket=bucket, Key=key)
    return resp["Body"].read().decode("utf-8", errors="replace")


def load_optional_text(s3, bucket: str, key: str) -> str:
    """For OPTIONAL list files (share-list.txt may not exist until the first
    folder is shared). A definitive NoSuchKey = empty text — NOT the same as a
    transient failure, which still raises (an empty parse must never be the
    result of an S3 hiccup)."""
    try:
        return load_whitelist_text(s3, bucket, key)
    except s3.exceptions.NoSuchKey:
        return ""
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "NoSuchKey":
            return ""
        raise


def parse_whitelist(text: str):
    rules = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        rules.append(line)
    return rules


def is_whitelisted(key: str, rules) -> bool:
    """key is a full S3 key relative to the scan root.

    Rules are also relative to the scan root, but folders can be nested
    (e.g. "2024/2024-10-08 Garda/..."), so a rule matches if it is a prefix
    of the key OR of any cumulative directory prefix of it.

    A rule starting with '!' is a NEGATION: that subtree (or single file) is
    private even though a parent rule publishes it. Exclusions always win,
    regardless of order:

        2024/
        !2024/2024-10-09 Réka privát/
    """
    def matches(rule: str) -> bool:
        if key.startswith(rule):
            return True
        dirs = key.split("/")[:-1]
        # single-segment rule: any folder component matches by prefix
        # ("2024-10-08 Garda" catches "2024/2024-10-08 Garda/...")
        for c in dirs:
            if c == rule or c.startswith(rule):
                return True
        # multi-segment rule ("2026-01-23 Street/_Export"): appears
        # contiguously somewhere in the folder path, at any depth
        if "/" in rule and ("/" + rule) in ("/" + "/".join(dirs) + "/"):
            return True
        return False

    for rule in rules:
        if rule.startswith("!") and matches(rule[1:]):
            return False
    for rule in rules:
        if not rule.startswith("!") and matches(rule):
            return True
    return False


def slugify(name: str) -> str:
    """ASCII-fold + lowercase + dash a folder name into a URL slug."""
    folded = unicodedata.normalize("NFKD", name)
    folded = "".join(c for c in folded if not unicodedata.combining(c))
    out = ""
    for c in folded.lower():
        if c.isascii() and (c.isalnum()):
            out += c
        elif out and out[-1] != "-":
            out += "-"
    return out.strip("-") or "shared"


def parse_share_list(text: str):
    """Parse share-list.txt: one shared folder per line, same matching rules
    as the public whitelist (prefix / trailing slash / all nested content).

    Line formats:
        2026/2026-08-14 Balaton        -> slug auto-derived from the last
                                          folder component (accent-folded)
        balaton: 2026/2026-08-14 B...  -> explicit slug ("slug: rule")
    Duplicated auto slugs from different rules get a short hash suffix so
    two same-named folders never collide. Returns [(slug, rule)].
    """
    import hashlib

    entries = []  # keep file order
    seen = {}     # slug -> rule (collision detection)
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        rule = line
        slug = None
        if ":" in line and not line.startswith("!"):
            head, rest = line.split(":", 1)
            head = head.strip()
            # explicit slug only when the head is a plain token (no '/'; a
            # space is allowed since folder names carry them, so require the
            # head to be short and slash-free to treat it as a slug)
            if head and "/" not in head and " " not in head and len(head) <= 60:
                slug = slugify(head)
                rule = rest.strip()
        rule = rule.rstrip("/")
        if not rule:
            continue
        if not slug:
            slug = slugify(rule.split("/")[-1])
        base = slug
        if slug in seen and seen[slug] != rule:
            slug = f"{slug}-{hashlib.sha1(rule.encode()).hexdigest()[:6]}"
        while slug in seen and seen[slug] != rule:
            slug = f"{base}-x{len(entries)}"
        seen[slug] = rule
        entries.append((slug, rule))
    # ensure list-order uniqueness even for exact duplicate lines
    out, used = [], set()
    for slug, rule in entries:
        s = slug if slug not in used else f"{slug}-x{len(out)}"
        used.add(s)
        out.append((s, rule))
    return out


def is_shared(key: str, share_rules) -> bool:
    """key (relative to scan root) falls under any share rule — same matching
    semantics as one positive whitelist rule (no negations here)."""
    return any(is_whitelisted(key, [rule]) for _slug, rule in share_rules)


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
