// "Already known": the sites discovery must never bring back as new
// (docs/DISCOVERY.md). The list (feed.json, additions.json) and the rejected
// sites (excluded.json) are kept as site keys (lib/grader/url.mjs siteKeyOf:
// host without www, then the path). A found address is known when it is the
// same SITE as a known one, and what counts as one site depends on the host:
//
//   an ordinary host        one site per host. `missaelr.com/en`, the
//                           root and `missaelr.com/about` are all the same
//                           site, so rejecting one rejects the others.
//   a project-page host     (user.github.io, user.gitlab.io) one site per
//                           host and first path segment. The user's root site
//                           and each project page are different sites that
//                           happen to share an owner: rejecting
//                           `user.github.io/a` does not reject
//                           `user.github.io/b`, nor the root; it does cover
//                           `user.github.io/a/docs`.
//   a path-significant host (PATH_SIGNIFICANT below) one site per full
//                           path: many unrelated people live under the same
//                           host, so the host alone must never match.
//
// Each host's rule is applied to both the known entry and the found address,
// so the check is symmetric (a known path blocks the root and the reverse).

/**
 * Hosts where the whole path names the site (link shorteners, hosting and
 * portfolio-builder platforms that put each person under a path). Found by
 * looking at the hosts of data/feed.json, additions.json and excluded.json
 * that carry many different first path segments, plus the well-known
 * shorteners that PLATFORM_HOST (normalize.mjs) does not already refuse. A
 * host here also covers its subdomains.
 */
export const PATH_SIGNIFICANT = [
  "dub.sh",
  "dinq.me",
  "muse.ai",
  "rebrand.ly",
  "vidu.sh",
  "entry.fyi",
  "forkfolio.dev",
  "portfolic.vercel.app",
  "txtnode.com",
  "mylivecv.com",
  "crio.do",
  "obem.be",
  "tinyurl.com",
  "cutt.ly",
  "is.gd",
  "t.ly",
  "lnk.bio",
];

/** Hosts whose first path segment is a project of the account named by the subdomain. */
export const PROJECT_PAGE_HOST = /\.(github|gitlab)\.io$/;

const hostIn = (host, list) => list.some((h) => host === h || host.endsWith(`.${h}`));

/**
 * The scope of one site key: the string two keys share exactly when they are
 * the same site under the rules above.
 * @param {string} key a site key, host then path (siteKeyOf)
 */
export function siteScope(key) {
  const slash = key.indexOf("/");
  const host = slash < 0 ? key : key.slice(0, slash);
  const segments = slash < 0 ? [] : key.slice(slash + 1).split("/").filter(Boolean);
  if (hostIn(host, PATH_SIGNIFICANT)) return segments.length ? `${host}/${segments.join("/")}` : host;
  if (PROJECT_PAGE_HOST.test(host)) return segments.length ? `${host}/${segments[0]}` : host;
  return host;
}

/** A set of site keys that answers "is this the same site as one of them". */
export class Known {
  /** @param {Iterable<string>} keys */
  constructor(keys = []) {
    this.keys = new Set(keys);
    this.scopes = new Set([...this.keys].map(siteScope));
  }
  /** @param {string} key a site key */
  has(key) {
    return this.scopes.has(siteScope(key));
  }
}

/** A Known from what a caller holds: a Known stays, a set of keys is wrapped. */
export const asKnown = (listed) => (listed instanceof Known ? listed : new Known(listed ?? []));
