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

One site, one entry: two addresses are the same site when site_of() gives
them the same site key and nothing tells them apart (same_site). The first
entry of a site wins; an excluded site stays out under any spelling.

A site keeps the address it already has in the feed.json being replaced. The
address is the site's key in the database (votes, ratings, grades,
screenshots), so when upstream only spells it another way (a trailing slash,
www, http, upper case, the default port, a tracking parameter), the feed
keeps the old spelling and nothing is lost (pipeline/roster.mjs).

Usage:
    python generate_feed.py [README.md] [feed.json]
        [--exclude data/excluded.json] [--add data/additions.json]
        [--max-shrink 0.05]
    python generate_feed.py --site-keys FILE    (one address per line; prints
                                                 [site, extra] for each, as JSON)

--max-shrink refuses to write (exit 2) when the new feed has more than that
fraction fewer entries than the feed.json already there: a broken or
truncated upstream README must never wipe the list. For a real upstream
cleanup, the owner sets LIST_CLEANUP_SHARE (a share, e.g. 0.3) for one run:
it raises the limit here and in pipeline/roster.mjs syncRoster.
"""

import re
import os
import json
import sys
import argparse
from urllib.parse import urlsplit

PATTERN = re.compile(r"^-\s+\[([^\]]+)\]\(([^)]+)\)(?:\s+\[([^\]]*)\])?")
CLEANUP_SHARE_ENV = "LIST_CLEANUP_SHARE"

# Query parameters that only say where a visitor came from (pipeline/roster.mjs TRACKING_PARAM).
TRACKING_PARAM = re.compile(r"^(utm_[a-z0-9_]*|ref|src|source|fbclid|gclid|igshid|mc_cid|mc_eid)$")
# The WHATWG URL path percent-encode set, besides controls, space and non-ASCII.
PATH_ENCODE = set('"#<>?`{}')
SINGLE_DOT = {".", "%2e"}
DOUBLE_DOT = {"..", ".%2e", "%2e.", "%2e%2e"}


def _url_path(path):
    """A path the way a WHATWG URL parser (Node's `new URL`) serializes it."""
    path = path.replace("\\", "/")
    out = []
    segments = path.split("/")[1:] if path.startswith("/") else path.split("/")
    for i, seg in enumerate(segments):
        last = i == len(segments) - 1
        low = seg.lower()
        if low in DOUBLE_DOT:
            if out:
                out.pop()
            if last:
                out.append("")
        elif low in SINGLE_DOT:
            if last:
                out.append("")
        else:
            out.append(seg)
    encoded = []
    for ch in "/" + "/".join(out):
        if ord(ch) <= 0x20 or ord(ch) >= 0x7F or ch in PATH_ENCODE:
            encoded.append("".join(f"%{b:02X}" for b in ch.encode("utf-8")))
        else:
            encoded.append(ch)
    return "".join(encoded)


def site_key_of(url):
    """lib/grader/url.mjs siteKeyOf: host without www, path without the trailing
    slash, lower case. Raises ValueError where `new URL` would throw."""
    # Before the query and fragment, an http(s) URL reads "\" as "/".
    cut = min([i for i in (url.find("?"), url.find("#")) if i >= 0], default=len(url))
    parts = urlsplit(url[:cut].replace("\\", "/") + url[cut:])
    host = parts.hostname
    if not host or any(c in host for c in ' <>^|%"'):
        raise ValueError(f"no host in {url!r}")
    port = parts.netloc.rpartition("@")[2]
    if not port.startswith("[") and ":" in port:
        digits = port.rsplit(":", 1)[1]
        if digits and (not digits.isdigit() or int(digits) > 65535):
            raise ValueError(f"bad port in {url!r}")
    try:
        host = host.encode("idna").decode("ascii") if not host.isascii() else host
    except UnicodeError as e:
        raise ValueError(str(e))
    host = host.lower()
    if host.startswith("www."):
        host = host[4:]
    return f"{host}{_url_path(parts.path).rstrip('/').lower()}"


def site_of(url):
    """pipeline/roster.mjs siteOf: (site key, what tells two entries of one site apart)."""
    raw = (url or "").strip()
    lower = raw.lower()
    if not re.match(r"^https?://", lower):
        return (lower, "")
    try:
        site = site_key_of(raw)
    except ValueError:
        return (lower, "")
    before_hash, _, fragment = lower.partition("#")
    has_hash = "#" in lower
    query = before_hash.partition("?")[2] if "?" in before_hash else ""
    params = sorted(p for p in query.split("&") if p and not TRACKING_PARAM.match(p.split("=")[0]))
    route = fragment.rstrip("/") if has_hash and re.match(r"^!?/", fragment) else ""
    extra = (f"?{'&'.join(params)}" if params else "") + (f"#{route}" if route and route != "!" else "")
    return (site, extra)


def same_site(a, b):
    """Same site key, and nothing that tells them apart (equal extras, or one has none)."""
    return a[0] == b[0] and (a[1] == b[1] or not a[1] or not b[1])


class Sites:
    """A set of addresses that answers "is this the same site as one of them"."""

    def __init__(self, urls=()):
        self.by_site = {}
        for u in urls:
            self.add(u)

    def add(self, url):
        key = site_of(url)
        self.by_site.setdefault(key[0], []).append((key, url))

    def matches(self, url):
        key = site_of(url)
        return [u for k, u in self.by_site.get(key[0], []) if same_site(key, k)]


def load_json_array(path):
    if not path:
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return []


def keep_spellings(portfolios, previous):
    """Give each entry the address its site already has in the previous feed,
    when that is unambiguous both ways. Returns how many were kept."""
    before = Sites(p.get("url") or "" for p in previous)
    now = {p["url"] for p in portfolios}
    prev_urls = {p.get("url") for p in previous}
    picks = {}
    for i, entry in enumerate(portfolios):
        if entry["url"] in prev_urls:
            continue
        hits = [u for u in before.matches(entry["url"]) if u not in now]
        if len(hits) == 1:
            picks[i] = hits[0]
    counts = {}
    for u in picks.values():
        counts[u] = counts.get(u, 0) + 1
    kept = 0
    for i, u in picks.items():
        if counts[u] == 1:
            portfolios[i]["url"] = u
            kept += 1
    return kept


def build_feed(readme_path, exclude_path, add_path, previous=None):
    with open(readme_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    excluded = Sites(
        e if isinstance(e, str) else (e.get("url") or "")
        for e in load_json_array(exclude_path)
    )
    portfolios = []
    seen = Sites()
    dupes = excluded_hits = 0

    for line in lines:
        m = PATTERN.match(line.strip())
        if not m:
            continue
        name, url = m.group(1).strip(), m.group(2).strip()
        tagline = m.group(3).strip() if m.group(3) else None
        if excluded.matches(url):
            excluded_hits += 1
            continue
        if seen.matches(url):
            dupes += 1
            continue
        seen.add(url)
        entry = {"name": name, "url": url}
        if tagline:
            entry["tagline"] = tagline
        portfolios.append(entry)

    added = 0
    for entry in load_json_array(add_path):
        url = (entry.get("url") or "").strip()
        if not url:
            continue
        if excluded.matches(url) or seen.matches(url):
            continue
        seen.add(url)
        # Normalize like the README path so name is always present (required by
        # the Portfolio type / rendered into the detail-page <h1>).
        name = (entry.get("name") or "").strip() or url
        norm = {"name": name, "url": url}
        tagline = (entry.get("tagline") or "").strip()
        if tagline:
            norm["tagline"] = tagline
        portfolios.append(norm)
        added += 1

    kept = keep_spellings(portfolios, previous or [])
    return portfolios, dupes, excluded_hits, added, kept


def max_shrink_allowed(cli_value):
    """--max-shrink, raised to LIST_CLEANUP_SHARE when the owner set it for one run."""
    raw = os.environ.get(CLEANUP_SHARE_ENV, "").strip()
    if not raw:
        return cli_value
    try:
        share = float(raw)
    except ValueError:
        share = -1
    if not 0 < share <= 1:
        raise SystemExit(f"Error: {CLEANUP_SHARE_ENV}={raw!r} is not a share between 0 and 1 (for example 0.3).")
    return share if cli_value is None else max(cli_value, share)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("readme", nargs="?", default="README.md")
    p.add_argument("output", nargs="?", default="feed.json")
    p.add_argument("--exclude", help="JSON array of URLs to drop")
    p.add_argument("--add", help="JSON array of extra {name,url,tagline} to include")
    p.add_argument("--max-shrink", type=float, default=None,
                   help="fail if the feed shrinks by more than this fraction")
    p.add_argument("--site-keys", help="print [site, extra] for each address in this file and stop")
    a = p.parse_args()

    if a.site_keys:
        with open(a.site_keys, "r", encoding="utf-8") as f:
            print(json.dumps([list(site_of(line.rstrip("\n"))) for line in f], ensure_ascii=False))
        return 0

    current = load_json_array(a.output)
    try:
        portfolios, dupes, excluded_hits, added, kept = build_feed(a.readme, a.exclude, a.add, current)
    except FileNotFoundError:
        print(f"Error: {a.readme} not found.")
        return 1

    max_shrink = max_shrink_allowed(a.max_shrink)
    if max_shrink is not None:
        if current and len(portfolios) < len(current) * (1 - max_shrink):
            print(
                f"Error: the new feed has {len(portfolios)} entries, "
                f"{len(current) - len(portfolios)} fewer than the current {len(current)} "
                f"(more than {max_shrink:.0%}); refusing to write {a.output}. "
                f"For a real upstream cleanup, run once with {CLEANUP_SHARE_ENV} set to the share to allow."
            )
            return 2

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
    if kept:
        extras.append(f"{kept} kept their address")
    suffix = f"  ({', '.join(extras)})" if extras else ""
    print(f"✓ Wrote {a.output} with {len(portfolios)} entries.{suffix}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
