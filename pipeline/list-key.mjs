// One site on the list, one key: the rule every job uses to decide whether two
// addresses on the community list are the same listed site.
//
// The key is lib/grader/url.mjs siteKeyOf: host without www, path without the
// trailing slash, lower case; scheme, port, query and fragment ignored. So
// `https://x.dev/`, `http://www.X.dev` and `https://x.dev/?utm_source=gh` are
// one site, and excluding one spelling keeps them all out. An address that is
// not http(s) keeps its own trimmed, lower-cased text.
//
// It agrees with pipeline/health.mjs normKey on every address in data/
// (tests/roster-address-edit.test.mjs), so the health check and the weekly
// exclusions can import it instead, and with the app's site maps
// (lib/me.ts, lib/tools/server.ts), which key the list by siteKeyOf.

import { siteKeyOf } from "../lib/grader/url.mjs";

/** The key of one listed address. */
export function listKey(url) {
  const raw = String(url ?? "").trim();
  const lower = raw.toLowerCase();
  if (!/^https?:\/\//.test(lower)) return lower;
  try {
    return siteKeyOf(raw);
  } catch {
    return lower;
  }
}

/** Groups items by the key of their address: Map(key -> items, in order). */
export function byListKey(items, urlOf = (x) => x) {
  const groups = new Map();
  for (const item of items) {
    const key = listKey(urlOf(item));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

/**
 * Sites split by an upstream respelling: a delisted row and a listed row with
 * the same key. `rows`: [{ url, listed }]. Returns { pairs: [{ from, to }],
 * unclear: [urls] } where a pair is exactly one delisted and one listed row,
 * and unclear is any other group with a delisted and a listed row.
 */
export function splitSites(rows) {
  const pairs = [];
  const unclear = [];
  for (const group of byListKey(rows, (r) => r.url).values()) {
    const listed = group.filter((r) => r.listed);
    const delisted = group.filter((r) => !r.listed);
    if (!listed.length || !delisted.length) continue;
    if (listed.length === 1 && delisted.length === 1) pairs.push({ from: delisted[0].url, to: listed[0].url });
    else unclear.push(group.map((r) => r.url));
  }
  return { pairs, unclear };
}
