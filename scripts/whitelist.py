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
from datetime import datetime

import boto3


def load_whitelist_text(s3, bucket: str, key: str) -> str:
    try:
        resp = s3.get_object(Bucket=bucket, Key=key)
        return resp["Body"].read().decode("utf-8", errors="replace")
    except Exception:
        return ""


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
    """
    for rule in rules:
        if key.startswith(rule):
            return True
        parts = key.split("/")
        # a rule naming a folder must match ANY directory component of the
        # path, so "2024-10-08 Garda" catches "2024/2024-10-08 Garda/..."
        for part in parts[:-1]:
            if part == rule or part.startswith(rule):
                return True
    return False


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
