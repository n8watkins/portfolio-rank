// Discovery's "already known" rule: a site that is listed or rejected must
// never come back as new, whatever way its address is spelled, and a site a
// redirect leads to is one site with the address that redirected (the audit
// of 2026-11-16; pipeline/discovery/known.mjs, run.mjs). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { DISCOVERY_TABLES, addFound, seen } from "../lib/discovery/sites.mjs";
import { GRADER_TABLES } from "../lib/grader/schema.mjs";
import { normalizeCandidate } from "../pipeline/discovery/normalize.mjs";
import { discoveryCaps, newItems, runDiscovery } from "../pipeline/discovery/run.mjs";

const NOW = new Date("2026-11-16T22:00:00Z");
const fresh = async () => {
  const db = createClient({ url: ":memory:" });
  await db.batch([...GRADER_TABLES, ...DISCOVERY_TABLES], "write");
  return db;
};
/** The set listedKeys builds: normalised keys of every list entry. */
const list = (...urls) => new Set(urls.map((u) => normalizeCandidate(u).key));
/** The addresses of `found` that newItems lets through as new. */
const fresher = async (listed, ...found) => {
  const db = await fresh();
  const out = await newItems(db, found.map((url) => ({ url, source: "github" })), { listed });
  return out.map((i) => i.url);
};

test("known: an excluded address with a path also blocks its root, and an excluded root blocks a path", async () => {
  assert.deepEqual(await fresher(list("https://missaelr.com/en"), "https://missaelr.com/", "https://missaelr.com/en", "https://missaelr.com/about"), []);
  assert.deepEqual(await fresher(list("https://jane.dev"), "https://jane.dev/en", "https://jane.dev/portfolio/work"), []);
  assert.deepEqual(await fresher(list("https://jane.dev"), "https://sam.dev/en"), ["https://sam.dev/en"]);
});

test("known: www, scheme, case and trailing-slash spellings of a known host are known", async () => {
  const listed = list("https://missaelr.com/en");
  assert.deepEqual(await fresher(listed, "http://www.MissaelR.com/", "https://missaelr.com/EN/", "https://www.missaelr.com/en/index.html?x=1#top"), []);
});

test("known: a github.io project page is a site of its own, so only its own project is known", async () => {
  const listed = list("https://dangor220.github.io/developer-portfolio");
  assert.deepEqual(await fresher(listed, "https://dangor220.github.io/developer-portfolio", "https://dangor220.github.io/developer-portfolio/about"), []);
  assert.deepEqual(await fresher(listed, "https://dangor220.github.io/other-project"), ["https://dangor220.github.io/other-project"]);
  // The user site at the root is not the project page.
  assert.deepEqual(await fresher(listed, "https://dangor220.github.io/"), ["https://dangor220.github.io/"]);
  // A rejected user site does not take its projects with it, and another user's host is another site.
  assert.deepEqual(await fresher(list("https://dangor220.github.io"), "https://dangor220.github.io/p1", "https://dangor220.github.io/"), ["https://dangor220.github.io/p1"]);
  assert.deepEqual(await fresher(listed, "https://someone-else.github.io/developer-portfolio"), ["https://someone-else.github.io/developer-portfolio"]);
});

test("known: on a host where many people live under paths, only the same path is known", async () => {
  const listed = list("https://dub.sh/ankitdey", "https://muse.ai/s/neel-patel-portfolio/abc123", "https://dinq.me/sam");
  assert.deepEqual(await fresher(listed, "https://dub.sh/ankitdey", "https://www.dub.sh/ankitdey/"), []);
  assert.deepEqual(await fresher(listed, "https://dub.sh/", "https://dub.sh/someone-else", "https://muse.ai/s/another-person/xyz", "https://dinq.me/keith"), [
    "https://dub.sh/",
    "https://dub.sh/someone-else",
    "https://muse.ai/s/another-person/xyz",
    "https://dinq.me/keith",
  ]);
  assert.deepEqual(await fresher(listed, "https://muse.ai/s/neel-patel-portfolio/abc123"), []);
});

test("known: sites found twice in one run, with and without a path, are one site", async () => {
  const db = await fresh();
  const out = await newItems(db, ["https://jane.dev/", "https://jane.dev/en", "https://www.jane.dev/work"].map((url) => ({ url, source: "hn" })), { listed: new Set() });
  assert.deepEqual(out.map((i) => i.url), ["https://jane.dev/"]);
});

// ---------------------------------------------------------------- redirects

const page = (body, head = "<title>Alex Kim | Developer</title>") => `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
const LONG = "I'm Alex Kim, a software engineer. My projects, about me and contact. ".repeat(20);
const GOOD = page(`${LONG}<a href="https://github.com/alexkim">GitHub</a>`);

/** A fetchPage stand-in: `redirects` maps an address to the address it ends on. */
const web = (redirects = {}, bodies = {}) => async (url) => {
  if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
  const res = new Response(bodies[url] ?? GOOD, { status: 200, headers: { "content-type": "text/html" } });
  Object.defineProperty(res, "url", { value: redirects[url] ?? url });
  return res;
};
const run = (db, items, fetchPage, listed = new Set(), at = NOW) =>
  runDiscovery({ db, io: { fetchPage }, caps: discoveryCaps('{"found": 50, "screenRequests": 0}'), sources: [{ key: `s${at.getTime()}`, every: 1, read: async () => ({ items, cursor: {} }) }], now: at, listed, log: () => {} });
const src = (...urls) => urls.map((url) => ({ url, source: "github" }));
const row = (db, url) => seen(db, url);

test("redirect: a page that ends on an excluded host is a duplicate, whatever path it ends on", async () => {
  const db = await fresh();
  const s = await run(db, src("https://old-alex.dev/"), web({ "https://old-alex.dev/": "https://alexkim.dev/en" }), list("https://alexkim.dev"));
  assert.deepEqual(s.check.outcomes, { duplicate: 1 });
  assert.equal((await row(db, "https://old-alex.dev/")).status, "dropped");
  // And the other way round: the list has the path, the redirect lands on the root.
  const db2 = await fresh();
  const s2 = await run(db2, src("https://old-alex.dev/"), web({ "https://old-alex.dev/": "https://www.alexkim.dev/" }), list("https://alexkim.dev/en"));
  assert.deepEqual(s2.check.outcomes, { duplicate: 1 });
});

test("redirect: a redirect to a sibling github.io project does not hide a site", async () => {
  const db = await fresh();
  const s = await run(db, src("https://old-alex.dev/"), web({ "https://old-alex.dev/": "https://alex.github.io/new" }), list("https://alex.github.io/excluded-one"));
  assert.deepEqual(s.check.outcomes, { screen: 1 });
});

test("redirect: a redirect to a domain not seen yet is remembered, so finding that domain later is the same site", async () => {
  const db = await fresh();
  const fetchPage = web({ "https://old-alex.dev/": "https://alexkim.dev/" });
  const first = await run(db, src("https://old-alex.dev/"), fetchPage);
  assert.deepEqual(first.check.outcomes, { screen: 1 });
  // The live row now sits at the address the visitor ends on, and the old address is remembered as the same site.
  const live = await row(db, "https://alexkim.dev/");
  assert.equal(live.status, "screen");
  assert.equal((await row(db, "https://old-alex.dev/")).status, "dropped");
  assert.equal((await row(db, "https://old-alex.dev/")).reason, "duplicate");
  // Later the new domain is found (and the old one again): neither becomes a second candidate.
  const later = await run(db, src("https://alexkim.dev/", "https://www.old-alex.dev/"), fetchPage, new Set(), new Date(NOW.getTime() + 86_400_000));
  assert.deepEqual(later.sources[Object.keys(later.sources)[0]].new, 0);
  const rows = await db.execute("SELECT status, COUNT(*) AS n FROM discovery_sites GROUP BY status ORDER BY status");
  assert.deepEqual(rows.rows.map((r) => [r.status, Number(r.n)]), [["dropped", 1], ["screen", 1]]);
});

test("redirect: the row at the final address is the one that moves on, with the source and the address it was found at", async () => {
  const db = await fresh();
  await addFound(db, [{ url: "https://old-alex.dev/", source: "hn" }], { now: NOW });
  await run(db, [], web({ "https://old-alex.dev/": "https://alexkim.dev/About" }));
  const r = await db.execute("SELECT status, source, url FROM discovery_sites WHERE status = 'screen'");
  assert.deepEqual(r.rows.map((x) => [x.status, x.source, x.url]), [["screen", "hn", "https://alexkim.dev/About"]]);
});
