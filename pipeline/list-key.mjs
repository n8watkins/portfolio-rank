// One site on the list, one key: the rule every job uses to decide whether two
// addresses on the community list are the same listed site.
//
// THE RULE
//   1. The key of an address is its site key (lib/grader/url.mjs siteKeyOf:
//      host without www, path without the trailing slash, lower case; scheme,
//      port, query and fragment ignored): listKey(url). So excluding
//      `x.dev/?lang=en` keeps `x.dev/` out too, and `x.dev/?game` losing its
//      query is still the same site.
//   2. Only when the community list itself (the README plus our additions,
//      BEFORE exclusions) holds two or more entries with the same key does
//      what follows the path tell them apart: the query without tracking
//      parameters (utm, utm_*, ref, src, ...) and a hash route (#/alice,
//      #!/bob; a plain anchor such as #about is not one). Then each of those
//      entries is its own site, and an exclusion of one does not hit another.
//
// The feed build sees the whole list and marks every feed entry whose key the
// list holds more than once with `"siblings": true`, so every later job
// (roster sync, purge, owner removals, review relists, the repair) applies
// rule 2 over the same list even after one sibling was excluded:
// feedKeyer(feed). listKey has the call shape of pipeline/health.mjs normKey.

import { siteKeyOf } from "../lib/grader/url.mjs";

// Query parameters that only say where a visitor came from.
export const TRACKING_PARAM = /^(utm(_[a-z0-9_]*)?|ref|src|source|fbclid|gclid|igshid|mc_cid|mc_eid)$/;
/** The feed entry field that says the list holds other entries with this entry's key (rule 2). */
export const SIBLINGS = "siblings";

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
 * Rules 1 and 2: returns key(url), which is listKey(url) unless the list
 * `listUrls` holds two or more entries with that key, or the key is in
 * `shared` (keys the full list holds more than once), and then the key with
 * the query and hash route that tell them apart. Works for any address.
 */
export function keysForList(listUrls, shared = []) {
  const count = new Map();
  for (const u of listUrls) {
    const k = listKey(u);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const marked = new Set(shared);
  return (url) => {
    const k = listKey(url);
    return marked.has(k) || (count.get(k) ?? 0) >= 2 ? entryKey(url) : k;
  };
}

/** Rules 1 and 2 for a built feed: the keys its entries were built with (the `siblings` marks). */
export function feedKeyer(feed) {
  return keysForList(
    feed.map((p) => p.url),
    feed.filter((p) => p?.[SIBLINGS]).map((p) => listKey(p.url))
  );
}

/**
 * A site the list now spells another way, whose row has not moved yet: an
 * entry with no row of its own while exactly one stored row (`rows`, any
 * state) has its key and no entry has that row's address. Each such entry is
 * given the stored address, IN PLACE, so the feed and every job keep using
 * the row that holds the site's grade, votes and screenshots until the move
 * is applied. Returns { waiting: [{ stored, spelled }], unclear: [{ spelled, rows }] };
 * an unclear entry (several rows with its key) is left alone.
 */
export function pinWaiting(entries, rows, keyOf) {
  const listed = new Set(entries.map((e) => e.url));
  const stored = new Set(rows);
  const byKey = new Map();
  for (const u of rows) {
    if (listed.has(u)) continue;
    const k = keyOf(u);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(u);
  }
  const waiting = [];
  const unclear = [];
  const taken = new Set();
  for (const entry of entries) {
    if (stored.has(entry.url)) continue;
    const cands = byKey.get(keyOf(entry.url)) ?? [];
    if (cands.length > 1) unclear.push({ spelled: entry.url, rows: cands });
    if (cands.length !== 1 || taken.has(cands[0])) continue;
    taken.add(cands[0]);
    waiting.push({ stored: cands[0], spelled: entry.url });
    entry.url = cands[0];
  }
  return { waiting, unclear };
}

/** The job summary section for sites waiting for an address move ("" when there are none). */
export function waitingSummary({ waiting, unclear }) {
  if (!waiting.length && !unclear.length) return "";
  return [
    "### Waiting for an address move",
    "",
    `${waiting.length} site(s) the list now spells another way keep their stored address until the move is applied (see AUTOMATION.md, "Address moves").`,
    ...waiting.map((w) => `- ${w.stored} (the list says ${w.spelled})`),
    ...unclear.map((u) => `- unclear, more than one row has its key: ${u.spelled} (rows ${u.rows.join(", ")})`),
    "",
  ].join("\n");
}
