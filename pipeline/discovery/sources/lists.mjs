// Community lists people add themselves to with a pull request
// (docs/DISCOVERY.md "Sources"), read as diffs between commits. The cursor
// is the last commit read ({ sha }): an unchanged list costs one request,
// a changed one only its new entries, and the first run reads it whole.
//
//   personalsites  xdesro/personalsit.es: one YAML file per site under sites/
//   uses           wesbos/awesome-uses (uses.tech): src/data.js, one entry
//                  per person, `url` is their /uses page (reduced to the
//                  site's home page)
//
// emmabostian/developer-portfolios is not a discovery source: the nightly
// sync (sync-upstream.yml) already lists every entry it merges.
import { mapLimit } from "../http.mjs";
import { normalizeCandidate } from "../normalize.mjs";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

export const LISTS = {
  personalsites: { repo: "xdesro/personalsit.es", branch: "main" },
  uses: { repo: "wesbos/awesome-uses", branch: "master" },
};

/** The `url:` of a personalsit.es YAML file, or null. */
export function yamlUrl(text) {
  const m = String(text ?? "").match(/^url:\s*['"]?([^'"\s#]+)['"]?\s*$/m);
  return m ? m[1] : null;
}

/** Every `url:` value in uses.tech's data.js. */
export function dataJsUrls(text) {
  return [...String(text ?? "").matchAll(/\burl:\s*['"`]([^'"`\s]+)['"`]/g)].map((m) => m[1]);
}

async function head(ctx, { repo, branch }) {
  const c = await ctx.http.json(`${API}/repos/${repo}/commits/${branch}`);
  return String(c.sha);
}

/** personalsit.es: the sites added or changed since the cursor's commit (all of them on the first run). */
export async function readPersonalSites(ctx, cursor) {
  const list = LISTS.personalsites;
  const sha = await head(ctx, list);
  if (cursor?.sha === sha) return { items: [], cursor };
  let paths;
  if (cursor?.sha) {
    const cmp = await ctx.http.json(`${API}/repos/${list.repo}/compare/${cursor.sha}...${sha}`);
    // The compare API lists at most 300 files; past that, read the whole tree (the seen-set skips the old ones).
    paths = (cmp.files ?? []).length < 300 ? (cmp.files ?? []).filter((f) => f.status !== "removed").map((f) => String(f.filename)) : null;
  }
  if (!paths) {
    const tree = await ctx.http.json(`${API}/repos/${list.repo}/git/trees/${sha}?recursive=1`);
    paths = (tree.tree ?? []).map((t) => String(t.path));
  }
  paths = paths.filter((p) => /^sites\/[^/]+\.ya?ml$/i.test(p));
  const urls = await mapLimit(paths, 8, async (p) => yamlUrl(await ctx.http.text(`${RAW}/${list.repo}/${sha}/${p.split("/").map(encodeURIComponent).join("/")}`, { allow404: true })));
  const items = [];
  for (const u of urls) {
    const n = u && normalizeCandidate(u);
    if (n?.ok) items.push({ url: n.url, source: "personalsites", author: null, context: null });
  }
  return { items, cursor: { sha } };
}

/** uses.tech: the people added since the cursor's commit (everyone on the first run). */
export async function readUses(ctx, cursor) {
  const list = LISTS.uses;
  const sha = await head(ctx, list);
  if (cursor?.sha === sha) return { items: [], cursor };
  const now = dataJsUrls(await ctx.http.text(`${RAW}/${list.repo}/${sha}/src/data.js`));
  const before = cursor?.sha ? new Set(dataJsUrls(await ctx.http.text(`${RAW}/${list.repo}/${cursor.sha}/src/data.js`, { allow404: true }))) : new Set();
  const items = [];
  for (const u of now) {
    if (before.has(u)) continue;
    const n = normalizeCandidate(u, { root: true });
    if (n.ok) items.push({ url: n.url, source: "uses", author: null, context: null });
  }
  return { items, cursor: { sha } };
}
