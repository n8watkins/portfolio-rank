// One site on the list, one key: the rule every job uses to decide whether two
// addresses on the community list are the same listed site (the feed build,
// the roster sync, the purge, owner removals, review relists, and the repair
// of rows split before this rule; the health check's duplicates and the
// weekly exclusions should use it too).
//
//   listKey(url)  the site key (lib/grader/url.mjs siteKeyOf: host without
//                 www, path without the trailing slash, lower case; scheme
//                 and port ignored), then what still tells two entries on
//                 one site apart: the query without tracking parameters
//                 (utm_*, ref, src...) and a hash route (#/alice, #!/bob).
//                 A plain anchor (#about) tells nothing apart.
//
// Two addresses are the same listed site exactly when their keys are equal,
// so the rule is an equivalence: every grouping below is a plain Map lookup.
//
// The address a site is STORED under (portfolios.url, and every table keyed
// by it: votes, ratings, likes, lists, owner settings, review history) never
// changes once a row exists. When the list spells a stored site another way,
// its feed entry keeps the stored address as `url` and carries the list's
// current spelling as `href`: the address people are sent to and pages are
// fetched from (feedHref).

import { siteKeyOf } from "../lib/grader/url.mjs";

// Query parameters that only say where a visitor came from.
export const TRACKING_PARAM = /^(utm(_[a-z0-9_]*)?|ref|src|source|fbclid|gclid|igshid|mc_cid|mc_eid)$/;

/** The key of one listed site (see the top of this file). */
export function listKey(url) {
  const raw = String(url ?? "").trim();
  const lower = raw.toLowerCase();
  if (!/^https?:\/\//.test(lower)) return lower;
  let site;
  try {
    site = siteKeyOf(raw);
  } catch {
    return lower;
  }
  const hashAt = lower.indexOf("#");
  const beforeHash = hashAt < 0 ? lower : lower.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  const params = (queryAt < 0 ? "" : beforeHash.slice(queryAt + 1))
    .split("&")
    .filter((p) => p && !TRACKING_PARAM.test(p.split("=")[0]))
    .sort();
  const hash = hashAt < 0 ? "" : lower.slice(hashAt + 1).replace(/\/+$/, "");
  const route = /^!?\/./.test(hash) ? hash : "";
  return `${site}${params.length ? `?${params.join("&")}` : ""}${route ? `#${route}` : ""}`;
}

/** Groups items by the list key of their address: Map(key -> items, in order). */
export function byListKey(items, urlOf = (x) => x) {
  const groups = new Map();
  for (const item of items) {
    const key = listKey(urlOf(item));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

/** The address to visit and fetch for a feed entry: the list's current spelling. */
export const feedHref = (entry) => entry.href ?? entry.url;

/**
 * Gives each feed entry the address its site is stored under. `stored`:
 * [{ url, listed, graded }] (portfolios rows; listed = not delisted). An entry
 * whose own address is stored keeps it. Otherwise, when rows of the same site
 * exist, it takes one: the listed one first, then a graded one, then the
 * first by address (a site split before this rule has several; the repair
 * script merges them). The entry's own spelling moves to `href`. An address
 * is given to one entry only. Changes the entries in place and returns
 * [{ from, to }] for each one changed.
 */
export function pinToStored(entries, stored) {
  const exact = new Set(stored.map((s) => s.url));
  const groups = byListKey(stored, (s) => s.url);
  for (const rows of groups.values()) {
    rows.sort((a, b) => Number(b.listed) - Number(a.listed) || Number(b.graded) - Number(a.graded) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  }
  const taken = new Set(entries.map((e) => e.url).filter((u) => exact.has(u)));
  const pins = [];
  for (const entry of entries) {
    if (exact.has(entry.url)) continue;
    const pick = (groups.get(listKey(entry.url)) ?? []).find((r) => !taken.has(r.url));
    if (!pick) continue;
    taken.add(pick.url);
    pins.push({ from: entry.url, to: pick.url });
    if (entry.href === undefined) entry.href = entry.url;
    entry.url = pick.url;
    if (entry.href === entry.url) delete entry.href;
  }
  return pins;
}
