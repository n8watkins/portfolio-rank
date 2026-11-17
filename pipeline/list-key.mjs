// One site on the list, one key: the rule every job uses to decide whether two
// addresses on the community list are the same listed site. It is exactly the
// health check's pipeline/health.mjs normKey (and the old Python norm_key):
// lower-case the whole address first, then host without www and the path
// without the trailing slash; scheme, port, query and fragment ignored.
// tests/roster-address-edit.test.mjs checks the two agree on a generated table
// of addresses (non-ASCII, mixed-case percent escapes, spaces, braces), so the
// health lane can import this one instead.

/** The key of one listed address. */
export function listKey(url) {
  try {
    const u = new URL(String(url).trim().toLowerCase());
    const host = u.hostname.replace(/^www\./, "");
    return `${host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return String(url).trim().toLowerCase();
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
 * Sites split by upstream respellings: delisted rows whose key a listed row
 * has. `rows`: [{ url, delistedAt }] (delistedAt null for a listed row).
 * Returns { splits: [{ to, from: [old addresses, oldest delisting first] }],
 * unclear: [[urls]] } where a split has exactly one listed row, and unclear is
 * a key with two or more listed rows and a delisted one.
 */
export function splitSites(rows) {
  const splits = [];
  const unclear = [];
  for (const group of byListKey(rows, (r) => r.url).values()) {
    const listed = group.filter((r) => r.delistedAt == null);
    const delisted = group.filter((r) => r.delistedAt != null).sort((a, b) => String(a.delistedAt).localeCompare(String(b.delistedAt)));
    if (!listed.length || !delisted.length) continue;
    if (listed.length === 1) splits.push({ to: listed[0].url, from: delisted.map((r) => r.url) });
    else unclear.push(group.map((r) => r.url));
  }
  return { splits, unclear };
}
