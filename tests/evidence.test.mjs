// pipeline/evidence.mjs offline: the link re-check keeps the capture's rendered
// text and signals, and the run reports the sites still without evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createClient } from "@libsql/client";
import { nightsSince, pageEvidence, reportLines, sitesStillWaiting } from "../pipeline/evidence.mjs";
import { ensureRosterSchema } from "../pipeline/roster.mjs";
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
  return new Response("", { status: u.includes("gone") ? 404 : 200 });
};

test("a link re-check keeps the rendered page text and signals byte for byte and renews the link results", async () => {
  const db = await setup();
  await withSite(async (url) => {
    await insert(db, { url, pageText: RENDERED_TEXT, facts: RENDERED_FACTS });
    const row = (await db.execute({ sql: "SELECT url, name, meta, page_text, facts FROM portfolios WHERE url = ?", args: [url] })).rows[0];
    const out = await pageEvidence(db, row, { force: true, fetchImpl: fetchFor(url) });
    assert.equal(out.measured, true);
    const after = (await db.execute({ sql: "SELECT page_text, facts, facts_at FROM portfolios WHERE url = ?", args: [url] })).rows[0];
    const facts = JSON.parse(String(after.facts));
    assert.equal(after.page_text, RENDERED_TEXT);
    assert.deepEqual(facts.signals, RENDERED_FACTS.signals);
    assert.equal(JSON.stringify(facts.signals), JSON.stringify(RENDERED_FACTS.signals));
    assert.equal(facts.source, "rendered");
    assert.equal(facts.words, 14);
    assert.equal(facts.final_url, RENDERED_FACTS.final_url);
    assert.notDeepEqual(facts.project_links, RENDERED_FACTS.project_links, "the link results are new");
    assert.equal(facts.project_links.checked, 2);
    assert.equal(facts.project_links.broken, 1);
    assert.notEqual(facts.measured_at, RENDERED_FACTS.measured_at);
    assert.equal(after.facts_at, facts.measured_at, "the link check due date moves on");
  });
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
