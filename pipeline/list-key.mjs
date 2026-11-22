// One site on the list, one key: the rule every job uses to decide whether two
// addresses on the community list are the same listed site (the health check's
// normKey in pipeline/health.mjs is this function; the Python norm_key follows
// the same rule): lower-case the whole address first, then host without www
// and the path without the trailing slash; scheme, port, query and fragment
// ignored.

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

// Query parameters that only say where a visitor came from, never which page
// they get: utm_* and the click ids ad and mail platforms add.
const TRACKING_PARAM = /^(utm_.+|fbclid|gclid|gbraid|wbraid|dclid|msclkid|yclid|twclid|igshid|mc_cid|mc_eid|_ga|_gl)$/i;

/**
 * The key of one spelling of an address, for the feed build's sticky
 * spelling (pipeline/build-feed.mjs): two addresses with the same spelling
 * key can only be one site. Stricter than listKey on purpose: listKey
 * ignores the query and the fragment and the path's case, which can name two
 * different portfolios (`/?user=a` and `/?user=b`, `#/alice` and `#/bob`).
 * Only these may differ: the scheme, the host's case, a leading `www.`,
 * trailing slashes on the path, the scheme's default port, tracking parameters
 * (TRACKING_PARAM) added or removed, and an empty `?` or `#`. Everything else (path case, other query
 * parameters and their order, the fragment, a port, credentials) must be
 * exactly the same. Null for an address that is not http(s).
 */
export function spellingKey(url) {
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // URL drops a port that is its scheme's default.
  const port = u.port ? `:${u.port}` : "";
  const auth = u.username || u.password ? `${u.username}:${u.password}@` : "";
  const query = u.search
    .slice(1)
    .split("&")
    .filter((pair) => pair && !TRACKING_PARAM.test(decodeParamName(pair)))
    .join("&");
  return `${auth}${u.hostname.replace(/^www\./, "")}${port}${u.pathname.replace(/\/+$/, "")}${query ? `?${query}` : ""}${u.hash.length > 1 ? u.hash : ""}`;
}

function decodeParamName(pair) {
  const name = pair.split("=")[0];
  try {
    return decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return name;
  }
}

/**
 * Whether `url` is a plain web address: http(s), written out in full, with a
 * host name of two or more labels and none of the characters a README line
 * misread as an address carries (whitespace, `<`, `>`, brackets, a
 * backslash). False for `<[Portfolio-Link](https://khushm.netlify.app`,
 * `https\://shreyanshportfolio.in` and `abass.wanecrea.com`, which an older
 * parser read from the community list's README (data/feed.json history).
 */
export function isWebAddress(url) {
  const s = String(url ?? "");
  if (!/^https?:\/\/[^\s<>[\]()\\]+$/i.test(s)) return false;
  try {
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(new URL(s).hostname);
  } catch {
    return false;
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
