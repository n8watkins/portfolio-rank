#!/usr/bin/env python3
"""
Build feed.json = (upstream README) - (our exclusions) + (our additions).

- Upstream: every `- [Name](url) [tagline]` entry in a developer-portfolios
  README (the "accepted" community list).
- Exclusions (--exclude): URLs WE'VE removed (dead/unmaintained sites we don't
  want back even if upstream still lists them). JSON array of URL strings.
- Additions (--add): OUR OWN entries (e.g. direct submissions) not in upstream.
  JSON array of {name, url, tagline?}.

De-duplicated by normalized URL throughout. The first occurrence of a URL wins
and its ORIGINAL url string is preserved verbatim, so existing DB/rating keys
(which index on the exact url) are never rewritten.

Usage:
    python generate_feed.py [README.md] [feed.json]
        [--exclude data/excluded.json] [--add data/additions.json]
"""

import re
import json
import sys
import argparse
from urllib.parse import urlsplit

PATTERN = re.compile(r"^-\s+\[([^\]]+)\]\(([^)]+)\)(?:\s+\[([^\]]*)\])?")


def norm_key(url):
    """Dedup/exclusion key: lowercased host (no www) + path without trailing slash."""
    try:
        parts = urlsplit(url.strip().lower())
        host = parts.netloc
        if host.startswith("www."):
            host = host[4:]
        path = parts.path.rstrip("/")
        return f"{host}{path}" or url.strip().lower()
    except Exception:
        return url.strip().lower()


def load_json_array(path):
    if not path:
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return []


def build_feed(readme_path, exclude_path, add_path):
    with open(readme_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    excluded = {norm_key(u) for u in load_json_array(exclude_path)}
    portfolios = []
    seen = set()
    dupes = excluded_hits = 0

    for line in lines:
        m = PATTERN.match(line.strip())
        if not m:
            continue
        name, url = m.group(1).strip(), m.group(2).strip()
        tagline = m.group(3).strip() if m.group(3) else None
        key = norm_key(url)
        if key in excluded:
            excluded_hits += 1
            continue
        if key in seen:
            dupes += 1
            continue
        seen.add(key)
        entry = {"name": name, "url": url}
        if tagline:
            entry["tagline"] = tagline
        portfolios.append(entry)

    added = 0
    for entry in load_json_array(add_path):
        url = (entry.get("url") or "").strip()
        if not url:
            continue
        key = norm_key(url)
        if key in excluded or key in seen:
            continue
        seen.add(key)
        # Normalize like the README path so name is always present (required by
        # the Portfolio type / rendered into the detail-page <h1>).
        name = (entry.get("name") or "").strip() or url
        norm = {"name": name, "url": url}
        tagline = (entry.get("tagline") or "").strip()
        if tagline:
            norm["tagline"] = tagline
        portfolios.append(norm)
        added += 1

    return portfolios, dupes, excluded_hits, added


def main():
    p = argparse.ArgumentParser()
    p.add_argument("readme", nargs="?", default="README.md")
    p.add_argument("output", nargs="?", default="feed.json")
    p.add_argument("--exclude", help="JSON array of URLs to drop")
    p.add_argument("--add", help="JSON array of extra {name,url,tagline} to include")
    a = p.parse_args()

    try:
        portfolios, dupes, excluded_hits, added = build_feed(a.readme, a.exclude, a.add)
    except FileNotFoundError:
        print(f"Error: {a.readme} not found.")
        return 1

    with open(a.output, "w", encoding="utf-8") as f:
        json.dump(portfolios, f, indent=2, ensure_ascii=False)
        f.write("\n")

    extras = []
    if dupes:
        extras.append(f"{dupes} dup(s)")
    if excluded_hits:
        extras.append(f"{excluded_hits} excluded")
    if added:
        extras.append(f"{added} added")
    suffix = f"  ({', '.join(extras)})" if extras else ""
    print(f"✓ Wrote {a.output} with {len(portfolios)} entries.{suffix}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
