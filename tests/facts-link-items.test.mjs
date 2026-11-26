// The list of links a project-link check stores (pipeline/facts.mjs checkLinks
// `items`): one entry per candidate, { url, name, kind, verdict }, whose
// verdicts give back every count the check stores. Deterministic; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LINK_CHECK_MAX, LINK_ITEMS_MAX, LINK_NAME_MAX, LINK_VERDICTS, LOW_TIER, checkLinks, homeProjectLinks, linkName, measurePage, projectCandidates } from "../pipeline/facts.mjs";

/** A fake web: `pages` maps a full address to [status, html]; anything else answers `other`. */
const web = (pages, other = [200, ""]) => async (url, init) => {
  const [status, html] = pages[String(url)] ?? other;
  return new Response(init?.method === "HEAD" ? null : html, { status, headers: { "content-type": "text/html" } });
};

/** The counts, made again from the list alone. */
function recount(items) {
  const by = (v) => items.filter((it) => it.verdict === v).length;
  return {
    checked: by("ok") + by("broken") + by("blocked") + by("own_unverified"),
    ok: by("ok"),
    broken: by("broken"),
    blocked: by("blocked"),
    own_ok: items.filter((it) => it.verdict === "ok" && it.kind === "own page").length,
    own_unverified: by("own_unverified"),
    not_counted: by("not_counted"),
  };
}
/** Asserts the list is well formed and gives back exactly the counts stored beside it. */
function assertPartition(r, label) {
  assert.ok(Array.isArray(r.items), label);
  for (const it of r.items) {
    assert.deepEqual(Object.keys(it).sort(), ["kind", "name", "url", "verdict"], label);
    assert.ok(LINK_VERDICTS.includes(it.verdict), `${label}: ${it.verdict}`);
    assert.ok(it.kind === "outbound" || it.kind === "own page", label);
    assert.ok(it.name === null || (typeof it.name === "string" && it.name.length > 0 && it.name.length <= LINK_NAME_MAX), label);
  }
  const want = { checked: r.checked, ok: r.ok, broken: r.broken, blocked: r.blocked, own_ok: r.own_ok, own_unverified: r.own_unverified, not_counted: r.not_counted ?? 0 };
  assert.deepEqual(recount(r.items), want, label);
}

const SHELL = `<div id="root"><nav>Ana Ruiz Home Work About Contact</nav><p>Loading the app, please wait</p></div>`;
const HOME = "Ana Ruiz product designer in Madrid. Selected work, about me and contact.";
const caseStudy = (name) => `<main><h1>${name}</h1><p>${Array.from({ length: 70 }, (_, i) => `${name.toLowerCase()}word${i}`).join(" ")}</p></main>`;

test("outbound links: each verdict once, private and unreadable addresses listed as not checked, in the candidates' order", async () => {
  const cands = [
    { url: "https://live.example/", kind: "outbound", tier: 1, name: "Live app" },
    { url: "https://gone.example/", kind: "outbound", tier: 1, name: "Gone" },
    { url: "https://walled.example/", kind: "outbound", tier: 1, name: "Walled" },
    { url: "http://localhost:3000/", kind: "outbound", tier: 1, name: "Local" },
    { url: "not a url", kind: "outbound", tier: 1, name: null },
    "https://bare.example/",
  ];
  const r = await checkLinks(cands, { fetchImpl: web({ "https://gone.example/": [404, ""], "https://walled.example/": [403, ""] }) });
  assert.deepEqual(r.items, [
    { url: "https://live.example/", name: "Live app", kind: "outbound", verdict: "ok" },
    { url: "https://gone.example/", name: "Gone", kind: "outbound", verdict: "broken" },
    { url: "https://walled.example/", name: "Walled", kind: "outbound", verdict: "blocked" },
    { url: "http://localhost:3000/", name: "Local", kind: "outbound", verdict: "not_checked" },
    { url: "not a url", name: null, kind: "outbound", verdict: "not_checked" },
    { url: "https://bare.example/", name: null, kind: "outbound", verdict: "ok" },
  ]);
  assert.deepEqual([r.checked, r.ok, r.broken, r.blocked], [4, 2, 1, 1]);
  assertPartition(r, "outbound");
});

test("own pages on a catch-all host: a copy of another page's text is the unverified one, so the counts stay one per item", async () => {
  const pages = {
    "https://ana.dev/work/a": [200, caseStudy("Alpha")],
    "https://ana.dev/work/b": [200, caseStudy("Beta")],
    "https://ana.dev/work/c": [200, caseStudy("Beta")],
    "https://ana.dev/work/d": [200, "<p>Delta</p>"],
    "https://ana.dev/work/e": [404, "<h1>Gone</h1>"],
  };
  const own = ["a", "b", "c", "d", "e"].map((p) => ({ url: `https://ana.dev/work/${p}`, kind: "own page", tier: 2, name: `Case ${p}` }));
  // concurrency 1: the first of the two copies is checked first, so the second is the one not counted.
  const r = await checkLinks(own, { fetchImpl: web(pages, [200, SHELL]), homeText: HOME, concurrency: 1 });
  assert.equal(r.own_check, "text");
  assert.deepEqual(r.items.map((it) => it.verdict), ["ok", "ok", "own_unverified", "own_unverified", "broken"]);
  assert.deepEqual([r.ok, r.own_ok, r.own_unverified, r.broken], [2, 2, 2, 1]);
  assertPartition(r, "catch-all");
});

test("own pages on a host whose made-up address says not found, and on one that answers 404, with outbound links beside", async () => {
  const notFound = {
    "https://ana.dev/": [200, "<title>Ana Ruiz</title><h1>Ana</h1>"],
    "https://ana.dev/work/a": [200, "<title>Alpha</title><h1>Alpha</h1>"],
    "https://ana.dev/work/b": [200, "<title>Project Not Found</title>"],
    "https://out.example/": [500, ""],
  };
  const cands = [
    { url: "https://ana.dev/work/a", kind: "own page", tier: 2, name: "Alpha" },
    { url: "https://ana.dev/work/b", kind: "own page", tier: 2, name: "Beta" },
    { url: "https://out.example/", kind: "outbound", tier: 1, name: "Out" },
  ];
  const r = await checkLinks(cands, { fetchImpl: web(notFound, [200, "<title>Ana | Project Not Found</title>"]), homeUrl: "https://ana.dev/" });
  assert.equal(r.own_check, "not_found_page");
  assert.deepEqual(r.items.map((it) => it.verdict), ["ok", "broken", "broken"]);
  assertPartition(r, "not found page");
  const status = await checkLinks(cands, { fetchImpl: web({ "https://ana.dev/work/b": [403, ""] }, [404, ""]), homeUrl: "https://ana.dev/" });
  assert.equal(status.own_check, "status");
  assert.deepEqual(status.items.map((it) => it.verdict), ["broken", "blocked", "broken"]);
  assertPartition(status, "status");
});

test("the lowest tier: never requested, left out beside no loading project, counted beside one, and every link counting", async () => {
  const cands = [
    { url: "https://p1.example/", kind: "outbound", tier: 1, name: "P1" },
    { url: "https://uni.example/", kind: "outbound", tier: LOW_TIER, name: "University" },
    { url: "https://employer.example/", kind: "outbound", tier: LOW_TIER, name: "Employer" },
    { url: "http://127.0.0.1/", kind: "outbound", tier: LOW_TIER, name: "Local" },
  ];
  const deadProject = web({ "https://p1.example/": [404, ""] });
  // "never": the lowest tier is not requested; all of it, the private address too, is not counted.
  const never = await checkLinks(cands, { fetchImpl: deadProject, lowLinks: "never" });
  assert.deepEqual(never.items.map((it) => it.verdict), ["broken", "not_counted", "not_counted", "not_counted"]);
  assert.equal(never.not_counted, 3);
  assertPartition(never, "never");
  // "beside", no project link loads: what was requested of the lowest tier is not counted; the private one never was.
  const beside = await checkLinks(cands, { fetchImpl: deadProject, lowLinks: "beside" });
  assert.deepEqual(beside.items.map((it) => it.verdict), ["broken", "not_counted", "not_counted", "not_checked"]);
  assert.equal(beside.not_counted, 2);
  assertPartition(beside, "beside, none loads");
  // "beside", a project link loads: the lowest tier counts by its result.
  const counted = await checkLinks(cands, { fetchImpl: web({ "https://uni.example/": [404, ""] }), lowLinks: "beside" });
  assert.deepEqual(counted.items.map((it) => it.verdict), ["ok", "broken", "ok", "not_checked"]);
  assert.equal(counted.not_counted, undefined);
  assertPartition(counted, "beside, one loads");
  const all = await checkLinks(cands, { fetchImpl: deadProject, lowLinks: "all" });
  assert.deepEqual(all.items.map((it) => it.verdict), ["broken", "ok", "ok", "not_checked"]);
  assertPartition(all, "all");
  // No candidates: an empty list.
  const none = await checkLinks([], { fetchImpl: deadProject });
  assert.deepEqual(none.items, []);
  assertPartition(none, "none");
});

test("the list is capped: the candidates are at most LINK_CHECK_MAX, and a longer list of addresses is cut there", async () => {
  assert.equal(LINK_ITEMS_MAX, LINK_CHECK_MAX);
  const url = "https://ana.dev/";
  const many = Array.from({ length: 12 }, (_, i) => `<a href="https://p${i}.example/">P${i}</a>`).join("");
  const low = Array.from({ length: 12 }, (_, i) => `<a href="https://x${i}.example/">X${i}</a>`).join("");
  const cands = projectCandidates(homeProjectLinks({ html: `<section id="projects">${many}</section><p>${low}</p>`, url, finalUrl: url }), url, LINK_CHECK_MAX, { names: true });
  assert.equal(cands.length, LINK_CHECK_MAX);
  const r = await checkLinks(cands, { fetchImpl: web({}) });
  assert.equal(r.items.length, LINK_CHECK_MAX);
  assertPartition(r, "capped candidates");
  const long = await checkLinks(Array.from({ length: 20 }, (_, i) => `https://a${i}.example/`), { fetchImpl: web({}) });
  assert.equal(long.items.length, LINK_ITEMS_MAX);
  assert.equal(long.checked, 20, "the counts are not cut");
});

test("a link's name: its text, spaces collapsed, cut at LINK_NAME_MAX; none without text", () => {
  assert.equal(linkName({ text: "  Weather\n   app  " }), "Weather app");
  assert.equal(linkName({ text: "   " }), null);
  assert.equal(linkName({}), null);
  const long = linkName({ text: "word ".repeat(40) });
  assert.equal(long.length, LINK_NAME_MAX);
  assert.ok(long.endsWith("…"));
});

test("measurePage stores the list with each link's text: the kept link's, or another's when it has none; the candidates keep their shape", async () => {
  const url = "https://ana.dev/";
  const long = `Shop ${"really ".repeat(20)}long name`;
  const html =
    `<main><p>I worked at <a href="https://acme.example/">Acme Inc.</a></p>` +
    `<section id="projects"><h2>Projects</h2>` +
    `<a href="https://acme.example/"></a>` +
    `<a href="https://weather.example/">  Weather\n   app </a>` +
    `<a href="https://weather.example/">Live demo</a>` +
    `<a href="https://shop.example/">${long}</a>` +
    `<a href="/projects/notes">Notes case study</a>` +
    `</section><p><a href="https://uni.example/">My university</a></p></main>`;
  const f = await measurePage({ html, text: HOME, url, finalUrl: url }, { fetchImpl: web({ "https://shop.example/": [404, ""] }, [404, ""]) });
  const byUrl = Object.fromEntries(f.project_links.items.map((it) => [it.url, it]));
  assert.equal(byUrl["https://acme.example/"].name, "Acme Inc.", "the projects link has no text: the about's text names it");
  assert.equal(byUrl["https://acme.example/"].verdict, "broken", "kept as the projects link, so counted");
  assert.equal(byUrl["https://weather.example/"].name, "Weather app", "the first link kept names it");
  assert.equal(byUrl["https://shop.example/"].name.length, LINK_NAME_MAX);
  assert.equal(byUrl["https://shop.example/"].verdict, "broken");
  assert.equal(byUrl["https://uni.example/"].verdict, "not_counted");
  assert.deepEqual(byUrl["https://ana.dev/projects/notes"], { url: "https://ana.dev/projects/notes", name: "Notes case study", kind: "own page", verdict: "broken" });
  assert.deepEqual(f.project_links.items.map((it) => it.url), f.project_candidates.map((c) => c.url), "one item per candidate, in order");
  assert.ok(f.project_candidates.every((c) => !("name" in c)), "the stored candidates keep { url, from, kind, tier }");
  assertPartition(f.project_links, "measurePage");
  // Without `names`, the candidates are as before.
  assert.ok(projectCandidates(homeProjectLinks({ html, url, finalUrl: url }), url).every((c) => !("name" in c)));
});
