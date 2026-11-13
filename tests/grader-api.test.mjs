// End to end: "grade my portfolio" on the running production build (`npm run
// test:e2e`), with local stand-ins for the portfolio sites, GitHub's API
// and Gemini (scripts/test-e2e.sh points the server at this file's mock
// server; the stand-ins are honoured only off the deployed Workers). This
// test plays GitHub Actions' part: it claims the capture, records it and
// runs the free-tier grade through the people queue, as scripts/grade-jobs.mjs
// does. No request leaves the machine.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createClient } from "@libsql/client";
import { AI_CRITERIA } from "../pipeline/rubric.mjs";
import { budgetPlan } from "../pipeline/budget.mjs";
import { PRIMARY_MODEL } from "../pipeline/gemini.mjs";
import { claimCaptures, readJob } from "../lib/grader/jobs.mjs";
import { recordCapture } from "../lib/grader/finish.mjs";
import { queueFreeGrade } from "../lib/grader/free-grade.mjs";
import { listen } from "./helpers/listen.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const MOCK_PORT = Number(process.env.E2E_GRADER_MOCK_PORT ?? 7693);
const SHOTS_DIR = process.env.GRADER_TEST_SHOTS_DIR ?? path.join(process.cwd(), "data", "e2e-shots");
const SERVER_LOG = process.env.E2E_SERVER_LOG;
const enabled = process.env.GRADER_ENABLED === "true";
const db = createClient({ url: DB_URL, timeout: 10000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GOOD_KEY = `AIza${"G".repeat(35)}`;
const BAD_KEY = `AIza${"B".repeat(35)}`;
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
const answer = { is_portfolio: true, tier: "A", ...Object.fromEntries(AI_CRITERIA.map((c) => [c.id, { score: c.id === "writing" ? 2 : 4, note: `${c.id} note` }])), roles: ["frontend developer"] };

const PORTFOLIO = `<!doctype html><html><head><title>Jane Doe</title></head><body>
<h1>Jane Doe, frontend developer</h1><p>I build fast, accessible web apps for small teams and care about the details.</p>
<a href="https://github.com/jane-e2e">GitHub</a> <a href="mailto:jane@example.com">Email me</a> <a href="/resume.pdf">Resume</a>
<section id="projects"><h2>Projects</h2><a href="https://github.com/jane-e2e/shop">Shop</a> <a href="https://broken-e2e.dev/demo">Demo</a></section>
<footer>© 2026 Jane Doe</footer></body></html>`;

// ---------------------------------------------------------------------------
// The stand-ins
// ---------------------------------------------------------------------------
const seen = { dispatches: [], geminiKeys: [], generate: 0, sites: [] };
let mock;
function serveSite(u, res) {
  const host = new URL(u).hostname;
  seen.sites.push(host);
  if (host === "parked-e2e.dev") return res.writeHead(200, { "content-type": "text/html" }).end("<title>This domain is for sale</title><p>Buy this domain</p>");
  if (host === "down-e2e.dev") return res.writeHead(503).end("down");
  if (host === "broken-e2e.dev") return res.writeHead(404).end("gone");
  if (host === "github.com") return res.writeHead(200, { "content-type": "text/html" }).end("<title>GitHub</title>");
  if (host.endsWith("-e2e.dev")) return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PORTFOLIO.replace("Jane Doe", host.replace(/^www\./, "")));
  res.writeHead(404).end();
}
before(async () => {
  mock = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (url.pathname === "/site") return serveSite(url.searchParams.get("u"), res);
      if (url.pathname.startsWith("/github/repos/n8watkins/portfolio-rank/actions/workflows/grade.yml/dispatches")) {
        seen.dispatches.push({ auth: req.headers.authorization, body: JSON.parse(body || "{}") });
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ workflow_run_id: 1, html_url: "https://github.test/run/1" }));
      }
      if (url.pathname === `/gemini/models/${PRIMARY_MODEL}`) {
        seen.geminiKeys.push(req.headers["x-goog-api-key"]);
        return res.writeHead(req.headers["x-goog-api-key"] === GOOD_KEY ? 200 : 400, { "content-type": "application/json" }).end("{}");
      }
      if (url.pathname === `/gemini/models/${PRIMARY_MODEL}:generateContent`) {
        seen.geminiKeys.push(req.headers["x-goog-api-key"]);
        seen.generate++;
        if (req.headers["x-goog-api-key"] !== GOOD_KEY) return res.writeHead(400).end('{"error":{"message":"API key not valid","details":[{"reason":"API_KEY_INVALID"}]}}');
        return res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 90 } }));
      }
      res.writeHead(404).end();
    });
  });
  await listen(mock, MOCK_PORT);
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/leaderboard`)).status < 500) break;
    } catch {}
    await sleep(1000);
  }
});
after(() => mock?.close());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let ipSeq = 1;
function visitor({ ip = `203.0.113.${ipSeq++}` } = {}) {
  const c = new Map();
  return {
    ip,
    header: () => [...c].map(([k, v]) => `${k}=${v}`).join("; "),
    absorb(res) {
      for (const sc of res.headers.getSetCookie?.() ?? []) {
        const [k, v] = sc.split(";")[0].split(/=(.*)/s);
        c.set(k, v);
      }
    },
  };
}
async function call(v, method, p, body, { origin = BASE, redirect = "follow" } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    redirect,
    headers: { cookie: v.header(), "cf-connecting-ip": v.ip, ...(origin ? { origin } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  v.absorb(res);
  const text = res.headers.get("content-type")?.includes("json") ? await res.text() : "";
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const grade = (v, url, extra = {}) => call(v, "POST", "/api/grade", { url, ...extra });

/** What grade.yml does for a claimed job: the screenshot lands, the capture is recorded, a free-tier job is graded. */
async function runCaptureJob({ grade: gradeIt = true } = {}) {
  const jobs = await claimCaptures(db, { runId: "e2e", limit: 10 });
  for (const { id } of jobs) {
    const shotKey = `private/grades/${id}`;
    fs.mkdirSync(path.join(SHOTS_DIR, shotKey), { recursive: true });
    fs.writeFileSync(path.join(SHOTS_DIR, shotKey, "hero.jpg"), JPEG);
    const status = await recordCapture(db, id, { finalUrl: (await readJob(db, id)).url, shotKey, pageText: "Jane Doe, frontend developer. Mail jane@example.com.", facts: { github: true, resume: true, contact: true, own_domain: true, footer_year: 2026, template: null, project_links: { checked: 2, ok: 1, broken: 1, blocked: 0 } }, meta: { motion: false, domHash: "a", classHash: "b" } });
    if (status !== "grading" || !gradeIt) continue;
    const ctx = {
      db,
      apiKey: "e2e-key-not-real",
      plan: budgetPlan(),
      quota: { [PRIMARY_MODEL]: 500 },
      rpm: 600,
      now: () => Date.now(),
      sleep: async () => {},
      log: () => {},
      fetchImpl: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] }, finishReason: "STOP" }] }), { status: 200 }),
      image: async () => ({ inline_data: { mime_type: "image/jpeg", data: JPEG.toString("base64") } }),
      email: null,
      runId: "e2e",
    };
    await queueFreeGrade(ctx, await readJob(db, id));
  }
  return jobs.map((j) => j.id);
}

// ---------------------------------------------------------------------------
// The flows
// ---------------------------------------------------------------------------
test("off-site and malformed requests are refused before any work", { skip: !enabled }, async () => {
  const v = visitor();
  assert.equal((await call(v, "POST", "/api/grade", { url: "jane-e2e.dev" }, { origin: null })).status, 403);
  assert.equal((await call(v, "POST", "/api/grade", { url: "jane-e2e.dev" }, { origin: "https://evil.example" })).body.error, "bad_origin");
  assert.equal((await call(v, "POST", "/api/grade", "not json")).body.error, "bad_request");
  assert.equal((await call(v, "POST", "/api/grade", JSON.stringify({ url: "x".repeat(9000) }))).body.error, "bad_request", "bodies are capped");
  for (const [url, error] of [["http://169.254.169.254/latest/meta-data/", "ip_address"], ["https://jane-e2e.dev:8443/", "bad_port"], ["ftp://jane-e2e.dev/", "bad_scheme"], ["https://localhost/", "bad_host"], ["https://router.internal/", "private_address"]]) {
    const r = await grade(v, url);
    assert.equal(r.status, 400, url);
    assert.equal(r.body.error, error, url);
    assert.ok(r.body.message);
  }
  assert.equal((await grade(v, "jane-e2e.dev", { geminiKey: "sk-not-a-gemini-key" })).body.error, "own_key_invalid");
  assert.equal(seen.sites.length, 0, "no site was fetched for a refused request");
});

let reportId;
let owner;
test("a grade: free checks at once, one capture dispatched with no inputs, then the 3.5 grade and the report", { skip: !enabled }, async () => {
  owner = visitor();
  const before = seen.dispatches.length;
  const r = await grade(owner, "https://www.jane-e2e.dev/?ref=x#top");
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(r.headers.get("cache-control"), /private, no-store/);
  reportId = r.body.id;
  assert.match(reportId, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(r.body.url, "https://www.jane-e2e.dev/");
  assert.equal(r.body.status, "capturing");
  assert.equal(r.body.mine, true);
  assert.equal(r.body.checks.ok, true);
  const facts = Object.fromEntries(r.body.checks.facts.map((f) => [f.id, f.pass]));
  assert.deepEqual([facts.github, facts.contact, facts.resume, facts.fresh_footer, facts.project_links], [true, true, true, true, false]);
  assert.deepEqual(r.body.steps.map((s) => s.state), ["done", "running", "pending"]);
  assert.equal(seen.dispatches.length, before + 1);
  assert.deepEqual(seen.dispatches.at(-1).body.inputs, {}, "the public run carries no job id");
  assert.equal(seen.dispatches.at(-1).auth, "Bearer e2e-dispatch-token");
  assert.ok(!JSON.stringify(seen.dispatches.at(-1)).includes(reportId));

  await runCaptureJob();
  const g = await call(visitor(), "GET", `/api/grade/${reportId}`);
  assert.equal(g.status, 200);
  assert.equal(g.body.status, "done");
  assert.equal(g.body.mine, false, "anyone with the link can read it; only the owner owns it");
  const rep = g.body.report;
  assert.equal(rep.tier, "A");
  assert.equal(rep.model, PRIMARY_MODEL);
  assert.equal(rep.ownKey, false);
  assert.deepEqual(rep.roles, ["frontend developer"]);
  assert.equal(rep.judgments.length, AI_CRITERIA.length);
  assert.ok(rep.facts.some((f) => f.id === "project_links" && f.pass === false));
  assert.ok(rep.fixes.length >= 1 && rep.fixes.length <= 3);
  assert.ok(rep.strengths.length >= 1);
  assert.ok("percentile" in rep && Array.isArray(rep.similar) && Array.isArray(rep.better));
  assert.ok(!JSON.stringify(g.body).includes("jane@example.com"), "page text and addresses never come back");
  assert.equal(g.headers.get("x-robots-tag"), "noindex, nofollow");
  const shot = await fetch(`${BASE}${g.body.shots.hero}`);
  assert.equal(shot.status, 200);
  assert.equal(shot.headers.get("content-type"), "image/jpeg");
  assert.match(shot.headers.get("cache-control"), /^private/);
  assert.equal((await fetch(`${BASE}/shots/private/grades/${reportId}/hero.jpg`)).status, 404, "the public /shots route never serves the private prefix");
  const log = (await db.execute("SELECT job, model FROM gemini_requests WHERE job = 'people-grade'")).rows;
  assert.ok(log.length >= 1 && log.every((x) => x.model === PRIMARY_MODEL), "counted as people's 3.5 requests");
});

test("get it by email: a one-time link through the email gate makes this browser the owner", { skip: !enabled }, async () => {
  const stranger = visitor();
  assert.equal((await call(stranger, "POST", `/api/grade/${reportId}/email`, { email: "not-an-address" })).body.error, "bad_email");
  const r = await call(stranger, "POST", `/api/grade/${reportId}/email`, { email: "jane@example.com" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { requested: true, sent: true });
  const mail = (await db.execute("SELECT * FROM email_outbox WHERE kind = 'grade-report' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.equal(mail.to_addr, "jane@example.com");
  assert.match(String(mail.subject), /jane-e2e\.dev is ready/);
  const link = String(mail.text).match(/(\/api\/grade\/link\?t=\S+)/)[1];
  assert.equal((await db.execute({ sql: "SELECT email FROM grade_emails WHERE job_id = ?", args: [reportId] })).rows[0].email, null, "the address is erased once sent");
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM email_sends WHERE to_hash LIKE '%@%'")).rows[0].n, 0);

  const reader = visitor();
  const open = await call(reader, "GET", link, undefined, { redirect: "manual" });
  assert.equal(open.status, 303);
  assert.equal(new URL(open.headers.get("location")).pathname, `/grade/${reportId}`);
  assert.equal((await call(reader, "GET", `/api/grade/${reportId}`)).body.mine, true);
  const again = await call(visitor(), "GET", link, undefined, { redirect: "manual" });
  assert.match(again.headers.get("location"), /link=used$/, "one time only");
  assert.equal((await call(visitor(), "GET", "/api/grade/link?t=forged.token", undefined, { redirect: "manual" })).headers.get("location").endsWith("/grade?link=bad"), true);
});

test("re-grades wait 7 days; only the owner is pointed at the earlier report", { skip: !enabled }, async () => {
  const mine = await grade(owner, "jane-e2e.dev");
  assert.equal(mine.status, 409);
  assert.equal(mine.body.error, "cooldown");
  assert.equal(mine.body.report, reportId);
  assert.ok(Date.parse(mine.body.nextAt) > Date.now() + 6 * 86400000);
  const other = await grade(visitor(), "https://jane-e2e.dev/");
  assert.equal(other.body.error, "cooldown");
  assert.equal(other.body.report, undefined, "a stranger can't discover the report by its address");
});

test("pages that can't be graded answer 422 and count nothing", { skip: !enabled }, async () => {
  const v = visitor();
  const caps = Number((await db.execute("SELECT COALESCE(SUM(n), 0) AS n FROM grade_caps")).rows[0].n);
  const parked = await grade(v, "parked-e2e.dev");
  assert.equal(parked.status, 422);
  assert.equal(parked.body.error, "parked");
  assert.equal((await grade(v, "down-e2e.dev")).body.error, "http_error");
  assert.equal(Number((await db.execute("SELECT COALESCE(SUM(n), 0) AS n FROM grade_caps")).rows[0].n), caps);
  // The free checks are cached per address: asking again doesn't fetch the site again.
  const fetched = seen.sites.filter((h) => h === "parked-e2e.dev").length;
  await grade(v, "parked-e2e.dev");
  assert.equal(seen.sites.filter((h) => h === "parked-e2e.dev").length, fetched);
});

test("daily caps: 3 a visitor, 6 a network, reserved atomically", { skip: !enabled }, async () => {
  const ip = "198.51.100.7";
  const a = visitor({ ip });
  for (let i = 1; i <= 3; i++) assert.equal((await grade(a, `cap${i}-e2e.dev`)).status, 202);
  // With the games on, each accepted request counts toward the grade badges.
  if (process.env.GAMES_V2 === "true") assert.equal((await call(a, "GET", "/api/badges")).body.counters.grades, 3);
  const over = await grade(a, "cap4-e2e.dev");
  assert.equal(over.status, 429);
  assert.deepEqual([over.body.error, over.body.scope], ["daily_limit", "visitor"]);
  assert.ok(Date.parse(over.body.resetAt) > Date.now());
  // Clearing cookies gives a new visitor, but the network is still counted.
  const b = visitor({ ip });
  for (let i = 4; i <= 6; i++) assert.equal((await grade(b, `cap${i}-e2e.dev`)).status, 202);
  const net = await grade(visitor({ ip }), "cap7-e2e.dev");
  assert.deepEqual([net.status, net.body.scope], [429, "network"]);
  // Concurrent requests from one visitor can't pass the cap together.
  const c = visitor();
  await grade(c, "warm-e2e.dev");
  const burst = await Promise.all([1, 2, 3, 4, 5].map((i) => grade(c, `burst${i}-e2e.dev`)));
  assert.equal(burst.filter((r) => r.status === 202).length, 2);
  await runCaptureJob({ grade: false });
});

test("daily caps: one IPv6 /48 gets 12 a day however many /64s it rotates through", { skip: !enabled }, async () => {
  const results = [];
  for (let i = 1; i <= 13; i++) results.push(await grade(visitor({ ip: `2001:db8:4800:${i.toString(16)}::1` }), `v6-${i}-e2e.dev`));
  assert.deepEqual(results.slice(0, 12).map((r) => r.status), Array(12).fill(202));
  assert.deepEqual([results[12].status, results[12].body.scope], [429, "network48"]);
  assert.equal((await grade(visitor({ ip: "2001:db8:4801:1::1" }), "v6-other-e2e.dev")).status, 202, "the next /48 is its own");
  await runCaptureJob({ grade: false });
});

test("own key: never checked with Google before the free checks and the caps pass", { skip: !enabled }, async () => {
  const v = visitor();
  for (let i = 1; i <= 3; i++) assert.equal((await grade(v, `keycap${i}-e2e.dev`)).status, 202);
  const asked = seen.geminiKeys.length;
  const r = await grade(v, "keycap4-e2e.dev", { geminiKey: BAD_KEY });
  assert.deepEqual([r.status, r.body.error], [429, "daily_limit"], "over the cap, the key isn't tested");
  assert.equal(seen.geminiKeys.length, asked, "Google was never asked");
  await runCaptureJob({ grade: false });
});

test("own key: checked for free, never stored or logged, used once to finish the grade on the visitor's quota", { skip: !enabled }, async () => {
  const v = visitor();
  assert.equal((await grade(v, "own-e2e.dev", { geminiKey: BAD_KEY })).body.error, "own_key_rejected");
  const r = await grade(v, "own-e2e.dev", { geminiKey: GOOD_KEY });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.ownKey, true);
  const id = r.body.id;
  assert.equal((await call(v, "POST", `/api/grade/${id}/finish`, { geminiKey: GOOD_KEY })).body.error, "not_waiting_for_key");
  await runCaptureJob();
  assert.equal((await call(v, "GET", `/api/grade/${id}`)).body.status, "awaiting_key");
  const logged = Number((await db.execute("SELECT COUNT(*) AS n FROM gemini_requests")).rows[0].n);
  const wrong = await call(v, "POST", `/api/grade/${id}/finish`, { geminiKey: BAD_KEY });
  assert.equal(wrong.body.error, "own_key_rejected");
  const done = await call(v, "POST", `/api/grade/${id}/finish`, { geminiKey: GOOD_KEY });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, "done");
  assert.equal(done.body.report.ownKey, true);
  assert.equal(done.body.report.model, PRIMARY_MODEL);
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM gemini_requests")).rows[0].n), logged, "the visitor's requests never count against our quota");
  // Nothing anywhere holds the key: the database, and the server's own log.
  for (const t of ["grade_jobs", "gemini_requests", "people_requests", "cache", "email_outbox"]) {
    const rows = (await db.execute(`SELECT * FROM ${t}`)).rows;
    assert.ok(!JSON.stringify(rows).includes(GOOD_KEY.slice(4, 20)), t);
  }
  if (SERVER_LOG && fs.existsSync(SERVER_LOG)) assert.ok(!fs.readFileSync(SERVER_LOG, "utf8").includes(GOOD_KEY.slice(4, 20)), "server log");
  assert.ok(seen.geminiKeys.includes(GOOD_KEY), "the key only went to Gemini, in its header");

  // Switching an own-key grade to the free tier.
  const s = await grade(v, "own2-e2e.dev", { geminiKey: GOOD_KEY });
  await runCaptureJob();
  const generated = seen.generate;
  const free = await call(v, "POST", `/api/grade/${s.body.id}/finish`, { freeTier: true });
  assert.equal(free.status, 202);
  // The request only enqueues, never on our Gemini key; the hourly drain grades it.
  assert.equal(free.body.status, "queued");
  assert.equal((await call(v, "GET", `/api/grade/${s.body.id}`)).body.status, "queued", "it waits in the people queue");
  assert.equal(seen.generate, generated, "no Gemini request from the visitor's request");
});

test("only the owner deletes a report, screenshots included", { skip: !enabled }, async () => {
  const v = visitor();
  const r = await grade(v, "delete-e2e.dev");
  await runCaptureJob({ grade: false });
  assert.equal((await call(visitor(), "DELETE", `/api/grade/${r.body.id}`)).body.error, "not_owner");
  assert.equal((await call(v, "DELETE", `/api/grade/${r.body.id}`, undefined, { origin: null })).status, 403);
  assert.equal((await call(v, "DELETE", `/api/grade/${r.body.id}`)).status, 204);
  assert.equal((await call(v, "GET", `/api/grade/${r.body.id}`)).status, 404);
  assert.equal((await call(v, "GET", "/api/grade/not-a-real-id")).status, 404);
});

test("attempts are rate limited per visitor before any work", { skip: !enabled }, async () => {
  const v = visitor();
  let limited = null;
  for (let i = 0; i < 25 && !limited; i++) {
    const r = await grade(v, "parked-e2e.dev");
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, "limited within 25 attempts");
  assert.equal(limited.body.error, "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
});
