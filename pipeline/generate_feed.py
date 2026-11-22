#!/usr/bin/env python3
"""
Build feed.json = (upstream README) - (our exclusions) + (our additions).

- Upstream: every `- [Name](url) [tagline]` entry in a developer-portfolios
  README (the "accepted" community list).
- Exclusions (--exclude): URLs WE'VE removed (dead/unmaintained sites we don't
  want back even if upstream still lists them). JSON array of URL strings or
  of {url, reason, kind, removed, ...} objects (pipeline/exclusions.mjs).
- Additions (--add): OUR OWN entries (e.g. direct submissions) not in upstream.
  JSON array of {name, url, tagline?}.

This file only reads the README. Everything that decides whether two
addresses are one site (duplicates, exclusions) is pipeline/build-feed.mjs,
so the rule lives in one place (pipeline/list-key.mjs); this script runs it
with Node and passes its exit code on. Addresses are written as the list
spells them, except a site already on the feed that the list respelled: it
keeps the feed's spelling (build-feed.mjs stickySpelling).

Usage:
    python generate_feed.py [README.md] [feed.json]
        [--exclude data/excluded.json] [--add data/additions.json]
        [--max-shrink 0.05]

The build refuses to write (exit 2) when the new feed has more than
--max-shrink fewer entries, or when more than 15% of the current entries'
addresses are gone from it: a broken, truncated or rewritten upstream README
must never reach the list. LIST_CLEANUP_SHARE (a share, e.g. 0.3) raises both
for one run, for a real upstream cleanup.
"""

import re
import os
import json
import sys
import argparse
import subprocess

PATTERN = re.compile(r"^-\s+\[([^\]]+)\]\(([^)]+)\)(?:\s+\[([^\]]*)\])?")
BUILD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "build-feed.mjs")


def parse_readme(readme_path):
    """Every `- [Name](url) [tagline]` entry, in order: [{name, url, tagline?}]."""
    with open(readme_path, "r", encoding="utf-8") as f:
        lines = f.readlines()
    entries = []
    for line in lines:
        m = PATTERN.match(line.strip())
        if not m:
            continue
        entry = {"name": m.group(1).strip(), "url": m.group(2).strip()}
        if m.group(3) and m.group(3).strip():
            entry["tagline"] = m.group(3).strip()
        entries.append(entry)
    return entries


def main():
    p = argparse.ArgumentParser()
    p.add_argument("readme", nargs="?", default="README.md")
    p.add_argument("output", nargs="?", default="feed.json")
    p.add_argument("--exclude", help="JSON array of URLs to drop")
    p.add_argument("--add", help="JSON array of extra {name,url,tagline} to include")
    p.add_argument("--max-shrink", type=float, default=None,
                   help="fail if the feed shrinks by more than this fraction")
    a = p.parse_args()

    try:
        entries = parse_readme(a.readme)
    except FileNotFoundError:
        print(f"Error: {a.readme} not found.")
        return 1

    cmd = ["node", BUILD, "-", a.output]
    if a.exclude:
        cmd += ["--exclude", a.exclude]
    if a.add:
        cmd += ["--add", a.add]
    if a.max_shrink is not None:
        cmd += ["--max-shrink", str(a.max_shrink)]
    sys.stdout.flush()
    run = subprocess.run(cmd, input=json.dumps(entries, ensure_ascii=False), text=True, encoding="utf-8")
    return run.returncode


if __name__ == "__main__":
    sys.exit(main())
