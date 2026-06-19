#!/usr/bin/env python3
"""
Generate feed.json from a developer-portfolios README.md.

Extracts every `- [Name](url) [tagline]` entry and writes structured JSON,
de-duplicating by normalized URL. The first occurrence of a URL wins and its
ORIGINAL url string is preserved verbatim (so existing DB/rating keys, which
index on the exact url, are never rewritten).

Usage:
    python generate_feed.py [README.md] [feed.json]
    (defaults: README.md -> feed.json)
"""

import re
import json
import sys
from urllib.parse import urlsplit

PATTERN = re.compile(r"^-\s+\[([^\]]+)\]\(([^)]+)\)(?:\s+\[([^\]]*)\])?")


def norm_key(url):
    """Dedup key: lowercased host (no www) + path without trailing slash."""
    try:
        parts = urlsplit(url.strip().lower())
        host = parts.netloc
        if host.startswith("www."):
            host = host[4:]
        path = parts.path.rstrip("/")
        return f"{host}{path}" or url.strip().lower()
    except Exception:
        return url.strip().lower()


def extract_portfolio_data(lines):
    portfolios = []
    seen = set()
    dupes = 0
    for line in lines:
        m = PATTERN.match(line.strip())
        if not m:
            continue
        name = m.group(1).strip()
        url = m.group(2).strip()
        tagline = m.group(3).strip() if m.group(3) else None
        key = norm_key(url)
        if key in seen:
            dupes += 1
            continue
        seen.add(key)
        entry = {"name": name, "url": url}
        if tagline:
            entry["tagline"] = tagline
        portfolios.append(entry)
    return portfolios, dupes


def create_feed_json(readme_path="README.md", output_path="feed.json"):
    try:
        with open(readme_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except FileNotFoundError:
        print(f"Error: {readme_path} not found.")
        return 0

    portfolios, dupes = extract_portfolio_data(lines)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(portfolios, f, indent=2, ensure_ascii=False)
        f.write("\n")
    if dupes:
        print(f"  ({dupes} duplicate URL(s) skipped)")
    return len(portfolios)


def main():
    readme = sys.argv[1] if len(sys.argv) > 1 else "README.md"
    output = sys.argv[2] if len(sys.argv) > 2 else "feed.json"
    count = create_feed_json(readme, output)
    if count:
        print(f"✓ Wrote {output} with {count} portfolio entries.")
        return 0
    print("✗ Failed to create feed.json")
    return 1


if __name__ == "__main__":
    sys.exit(main())
