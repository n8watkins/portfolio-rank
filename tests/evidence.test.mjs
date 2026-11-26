// pipeline/evidence.mjs offline: the link re-check keeps the capture's rendered
// text and signals, and the run reports the sites still without evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createClient } from "@libsql/client";
import { nightsSince, pageEvidence, reportLines, sitesStillWaiting } from "../pipeline/evidence.mjs";
import { ACTIVE, ensureRosterSchema } from "../pipeline/roster.mjs";
import { ensureFreshnessSchema, linksDue } from "../lib/freshness.mjs";
import { listen } from "./helpers/listen.mjs";

const RENDERED_TEXT = "Ada Lovelace - engineer. Projects: Engine, Notes. About me. Contact. Resume. GitHub.";
const RENDERED_FACTS = {
  v: 1,
  source: "rendered",
  final_url: "https://ada.dev/",
  signals: { score: 5, projects: true, about: true, contact: true, resume: true, github: true, name: true },
  words: 14,
  project_links: { checked: 3, ok: 3, broken: 0, blocked: 0 },
  measured_at: "2026-11-01T00:00:00.000Z",
};

async function setup() {
  const db = createClient({ url: ":memory:" });
  await ensureRosterSchema(db);
  return db;
}

async function insert(db, { url, pageText = null, facts = null, capturedAt = "2026-11-10 02:00:00" }) {
  await db.execute({
    sql: `INSERT INTO portfolios (url, name, status, shot_key, page_text, facts, facts_at, captured_at)
          VALUES (?, 'Ada', 'live', 'k', ?, ?, ?, ?)`,
    args: [url, pageText, facts ? JSON.stringify(facts) : null, facts?.measured_at ?? null, capturedAt],
  });
}

// A plain-HTTP server whose page is longer than the stored text but has no signals, with one good and one dead project link.
async function withSite(fn) {
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") return res.writeHead(200).end("ok");
    if (req.url === "/gone") return res.writeHead(404).end("no");
    const filler = "This server-rendered text is much longer than the stored text and different from it. ".repeat(8);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body><p>${filler}</p><a href="https://github.com/ada/engine">Engine</a><a href="https://ada.example/gone">Gone</a></body></html>`);
  });
  const port = await listen(server, 0);
  try {
    await fn(`http://127.0.0.1:${port}/`);
  } finally {
    server.close();
  }
}

// Routes the page to the local server and every project link to a fixed verdict.
const fetchFor = (pageUrl) => async (input, init) => {
  const u = String(input);
  if (u === pageUrl) return fetch(u, init);
  return new Response("", { status: u.includes("gone") || u.includes("no-such-page") ? 404 : 200 });
};

// The links the capture chose, from its desktop and phone views and the projects page (facts version 3).
const CHOSEN = [
  { url: "https://ada.example/engine", from: "home", kind: "outbound", tier: 1 },
  { url: "https://ada.example/gone", from: "phone", kind: "outbound", tier: 1 },
  { url: "https://ada.dev/projects/notes", from: "projects_page", kind: "own page", tier: 2 },
];

test("a link re-check of version 3 facts stored without tiers does not count every link: unknown until the next capture", async () => {
  const db = await setup();
  const url = "https://ada.dev/";
  const untiered = CHOSEN.map(({ url: u, from, kind }) => ({ url: u, from, kind }));
  await insert(db, { url, pageText: RENDERED_TEXT, facts: { ...RENDERED_FACTS, v: 3, project_candidates: untiered } });
  const row = (await db.execute({ sql: "SELECT url, name, meta, page_text, facts FROM portfolios WHERE url = ?", args: [url] })).rows[0];
  const asked = [];
  const out = await pageEvidence(db, row, { force: true, fetchImpl: async (input) => (asked.push(String(input)), new Response(null, { status: 200 })) });
  assert.equal(out.facts.project_links, null);
  assert.equal(out.facts.project_links_note, "measured before tiers: needs a new capture");
  assert.deepEqual(asked, [], "nothing is requested");
});

// Version 4 (the trial's misses fixed) is re-checked exactly as version 3 is.
for (const v of [3, 4]) test(`a link re-check of version ${v} facts tests again the links the capture chose, and keeps the rendered text and signals byte for byte`, async () => {
  const db = await setup();
  await withSite(async (url) => {
    await insert(db, { url, pageText: RENDERED_TEXT, facts: { ...RENDERED_FACTS, v, project_candidates: CHOSEN } });
    const row = (await db.execute({ sql: "SELECT url, name, meta, page_text, facts FROM portfolios WHERE url = ?", args: [url] })).rows[0];
    const asked = [];
    const out = await pageEvidence(db, row, {
      force: true,
      fetchImpl: async (input, init) => {
        asked.push(String(input));
        return fetchFor(url)(input, init);
      },
    });
    assert.equal(out.measured, true);
    // Only the chosen links (and one address that cannot exist, which tells whether the host answers every address),
    // never the page itself: its plain-HTTP links (github.com/ada/engine) are not picked.
    const nonsense = asked.filter((u) => u.includes("/projects/no-such-page-"));
    assert.equal(nonsense.length, 1);
    assert.deepEqual([...new Set(asked.filter((u) => !nonsense.includes(u)))].sort(), CHOSEN.map((c) => c.url).sort());
    const after = (await db.execute({ sql: "SELECT page_text, facts, facts_at FROM portfolios WHERE url = ?", args: [url] })).rows[0];
    const facts = JSON.parse(String(after.facts));
    assert.equal(after.page_text, RENDERED_TEXT);
    assert.equal(JSON.stringify(facts.signals), JSON.stringify(RENDERED_FACTS.signals));
    assert.equal(facts.source, "rendered");
    assert.equal(facts.words, 14);
    assert.equal(facts.v, v, "the stored version stays");
    assert.deepEqual(facts.project_candidates, CHOSEN, "the capture's list is kept");
    // The host answers 404 for an address that cannot exist, so the own page counts by its status.
    // The stored counts had no list of links, so the renewed list has no names.
    const items = [
      { url: "https://ada.example/engine", name: null, kind: "outbound", verdict: "ok" },
      { url: "https://ada.example/gone", name: null, kind: "outbound", verdict: "broken" },
      { url: "https://ada.dev/projects/notes", name: null, kind: "own page", verdict: "ok" },
    ];
    assert.deepEqual(facts.project_links, { checked: 3, ok: 2, broken: 1, blocked: 0, own_ok: 1, own_unverified: 0, own_check: "status", items });
    assert.notEqual(facts.measured_at, RENDERED_FACTS.measured_at);
    assert.equal(after.facts_at, facts.measured_at, "the link check due date moves on");
  });
});

test("a link re-check renews the list of links with the names the capture listed them under", async () => {
  const db = await setup();
  await withSite(async (url) => {
    const listed = [
      { url: "https://ada.example/engine", name: "Engine", kind: "outbound", verdict: "ok" },
      { url: "https://ada.example/gone", name: "Gone", kind: "outbound", verdict: "ok" },
      { url: "https://ada.dev/projects/notes", name: null, kind: "own page", verdict: "ok" },
    ];
    const stored = { ...RENDERED_FACTS, v: 4, project_candidates: CHOSEN, project_links: { checked: 3, ok: 3, broken: 0, blocked: 0, own_ok: 1, own_unverified: 0, own_check: "status", items: listed } };
    await insert(db, { url, pageText: RENDERED_TEXT, facts: stored });
    const row = (await db.execute({ sql: "SELECT url, name, meta, page_text, facts FROM portfolios WHERE url = ?", args: [url] })).rows[0];
    await pageEvidence(db, row, { force: true, fetchImpl: fetchFor(url) });
    const facts = JSON.parse(String((await db.execute({ sql: "SELECT facts FROM portfolios WHERE url = ?", args: [url] })).rows[0].facts));
    assert.deepEqual(
      facts.project_links.items.map((it) => [it.name, it.verdict]),
      [["Engine", "ok"], ["Gone", "broken"], [null, "ok"]],
      "the names kept, the verdicts renewed"
    );
    assert.deepEqual(facts.project_candidates, CHOSEN, "the stored candidates keep their shape");
  });
});

test("a link re-check of facts of version 1 and 2 picks the links on a plain fetch as before, and keeps their version", async () => {
  const db = await setup();
  await withSite(async (url) => {
    await insert(db, { url, pageText: RENDERED_TEXT, facts: RENDERED_FACTS });
    const row = (await db.execute({ sql: "SELECT url, name, meta, page_text, facts FROM portfolios WHERE url = ?", args: [url] })).rows[0];
    const out = await pageEvidence(db, row, { force: true, fetchImpl: fetchFor(url) });
    assert.equal(out.measured, true);
    const after = (await db.execute({ sql: "SELECT page_text, facts, facts_at FROM portfolios WHERE url = ?", args: [url] })).rows[0];
    const facts = JSON.parse(String(after.facts));
    assert.equal(after.page_text, RENDERED_TEXT);
    assert.equal(facts.v, 1, "the old rule still reads it");
    assert.equal(facts.project_links.checked, 2);
    assert.equal(facts.project_links.broken, 1);
    assert.equal(facts.project_candidates, undefined, "no list is made up from a plain fetch");
    assert.equal(after.facts_at, facts.measured_at);
  });
});

test("the link re-check queue moves on: version 3 rows are reached behind 130 older rows, reachable or not", async () => {
  const db = await setup();
  await ensureFreshnessSchema(db);
  // 130 version 2 rows whose page does not answer, all due long ago, and one version 3 row due a little later.
  const old = Array.from({ length: 130 }, (_, i) => `https://old${String(i).padStart(3, "0")}.example/`);
  for (const url of old) await insert(db, { url, pageText: RENDERED_TEXT, facts: { ...RENDERED_FACTS, v: 2, measured_at: "2026-01-01T00:00:00.000Z" } });
  const v3 = "https://new.example/";
  await insert(db, { url: v3, pageText: RENDERED_TEXT, facts: { ...RENDERED_FACTS, v: 3, project_candidates: CHOSEN, measured_at: "2026-02-01T00:00:00.000Z" } });
  const fetchImpl = async (input) => new Response("", { status: String(input).startsWith("https://old") ? 503 : 200 });
  const reached = new Set();
  for (let night = 0; night < 3 && !reached.has(v3); night++) {
    for (const row of await linksDue(db, { limit: 120, active: ACTIVE })) {
      reached.add(String(row.url));
      await pageEvidence(db, row, { force: true, fetchImpl });
    }
  }
  assert.ok(reached.has(v3), "the version 3 row was reached on a later night");
  const after = JSON.parse(String((await db.execute({ sql: "SELECT facts FROM portfolios WHERE url = ?", args: [v3] })).rows[0].facts));
  assert.equal(after.project_links.checked, 3);
});

test("an unreachable page leaves stored evidence untouched on a link re-check", async () => {
  const db = await setup();
  const url = "https://ada.dev/";
  await insert(db, { url, pageText: RENDERED_TEXT, facts: RENDERED_FACTS });
  const row = (await db.execute({ sql: "SELECT url, name, meta, page_text, facts FROM portfolios WHERE url = ?", args: [url] })).rows[0];
  const out = await pageEvidence(db, row, { force: true, fetchImpl: async () => new Response("", { status: 503 }) });
  assert.equal(out.measured, false);
  const after = (await db.execute({ sql: "SELECT page_text, facts FROM portfolios WHERE url = ?", args: [url] })).rows[0];
  assert.equal(after.page_text, RENDERED_TEXT);
  assert.deepEqual(JSON.parse(String(after.facts)), RENDERED_FACTS);
});

test("a site with no page text is still measured, also by a link re-check", async () => {
  for (const force of [false, true]) {
    const db = await setup();
    await withSite(async (url) => {
      await insert(db, { url, facts: force ? RENDERED_FACTS : null });
      const row = (await db.execute({ sql: "SELECT url, name, meta, page_text, facts FROM portfolios WHERE url = ?", args: [url] })).rows[0];
      const out = await pageEvidence(db, row, { force, fetchImpl: fetchFor(url) });
      assert.equal(out.measured, true, `force=${force}`);
      const after = (await db.execute({ sql: "SELECT page_text, facts FROM portfolios WHERE url = ?", args: [url] })).rows[0];
      assert.match(String(after.page_text), /server-rendered text/);
      assert.equal(JSON.parse(String(after.facts)).source, "http");
    });
  }
});

test("the run reports the sites still without evidence, longest-waiting first", async () => {
  const db = await setup();
  const now = Date.parse("2026-11-16T03:00:00Z");
  await insert(db, { url: "https://new.dev/", capturedAt: "2026-11-15 02:00:00" });
  await insert(db, { url: "https://old.dev/", capturedAt: "2026-11-01 02:00:00" });
  await insert(db, { url: "https://done.dev/", pageText: "x", facts: RENDERED_FACTS });
  const still = await sitesStillWaiting(db, { now, show: 1 });
  assert.equal(still.total, 2);
  assert.deepEqual(still.sites, [{ url: "https://old.dev/", nights: 15 }]);
  const lines = reportLines({ measured: 0, waitingForRun: 2, relinked: 4, linkTotal: 5, still });
  assert.match(lines[0], /measured 0 of 2/);
  assert.match(lines[1], /checked again 4 of 5/);
  assert.match(lines[2], /2 site\(s\) still without evidence/);
  assert.ok(lines.includes("  - https://old.dev/ - 15 night(s) since its capture"));
  assert.ok(lines.includes("  ... and 1 more"));
  assert.equal(nightsSince(null), null);
});
