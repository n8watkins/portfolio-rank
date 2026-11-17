// One site on the list, one key: the rule every job uses to decide whether two
// addresses on the community list are the same listed site.
//
// THE RULE
//   1. The key of an address is its site key (lib/grader/url.mjs siteKeyOf:
//      host without www, path without the trailing slash, lower case; scheme,
//      port, query and fragment ignored): listKey(url). Exclusions, owner
//      removals, review relists and respelling all use it, so excluding
//      `x.dev/?lang=en` keeps `x.dev/` out too, and `x.dev/?game` losing its
//      query is still the same site.
//   2. Only when the list itself holds two or more entries with the same key
//      does what follows the path tell them apart: the query without tracking
//      parameters (utm, utm_*, ref, src, ...) and a hash route (#/alice,
//      #!/bob; a plain anchor such as #about is not one). Then each of those
//      entries is its own site, and an exclusion of one does not hit the
//      other: keysForList(listUrls) gives that key for any address.
//
// listKey has the call shape of pipeline/health.mjs normKey and replaces it.

import { siteKeyOf } from "../lib/grader/url.mjs";

// Query parameters that only say where a visitor came from.
export const TRACKING_PARAM = /^(utm(_[a-z0-9_]*)?|ref|src|source|fbclid|gclid|igshid|mc_cid|mc_eid)$/;

/** Rule 1: the key of one address. */
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

/** The key plus what tells two entries with that key apart (rule 2). */
function entryKey(url) {
  const lower = String(url ?? "").trim().toLowerCase();
  const hashAt = lower.indexOf("#");
  const beforeHash = hashAt < 0 ? lower : lower.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  const params = (queryAt < 0 ? "" : beforeHash.slice(queryAt + 1))
    .split("&")
    .filter((p) => p && !TRACKING_PARAM.test(p.split("=")[0]))
    .sort();
  const hash = hashAt < 0 ? "" : lower.slice(hashAt + 1).replace(/\/+$/, "");
  const route = /^!?\/./.test(hash) ? hash : "";
  return `${listKey(url)}${params.length ? `?${params.join("&")}` : ""}${route ? `#${route}` : ""}`;
}

/**
 * Rules 1 and 2 for one list: returns key(url), which is listKey(url) unless
 * `listUrls` holds two or more entries with that listKey, and then the key
 * with the query and hash route that tell them apart. Works for any address,
 * listed or not (a stored row, an exclusion).
 */
export function keysForList(listUrls) {
  const count = new Map();
  for (const u of listUrls) {
    const k = listKey(u);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  return (url) => {
    const k = listKey(url);
    return (count.get(k) ?? 0) >= 2 ? entryKey(url) : k;
  };
}
