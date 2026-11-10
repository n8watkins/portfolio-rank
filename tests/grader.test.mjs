// "Grade my portfolio" offline (lib/grader, lib/email/gate.mjs): address
// checks, the daily caps, the re-grade cooldown, one-time links, the email
// gate's caps, report emails, the report, the capture dispatch, own-key
// grades and the people queue, on a throwaway database with a mocked
// GitHub and a mocked Gemini. No request leaves the machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { normalizeGradeUrl, siteKeyOf } from "../lib/grader/url.mjs";
import { isPublicIp } from "../lib/net-guard.mjs";
import { DEFAULT_CAPS, graderCaps, networkOf, reserveCaps, reserveSite } from "../lib/grader/caps.mjs";
import { JOB_ID, claimCaptures, createJob, newJobId, readJob, regradeCheck, setJob, shotKeyOf } from "../lib/grader/jobs.mjs";
import { MAX_DISPATCHES, NO_TOKEN_REASON, retryStalled, startCapture } from "../lib/grader/dispatch.mjs";
import { createLinkToken, openLinkToken, ownerCookieValue, readOwnerCookie } from "../lib/grader/links.mjs";
import { emailState, reportEmail, requestEmail, sendDueEmails } from "../lib/grader/notify.mjs";
import { addressHash, createEmailGate, emailTransport, validEmail } from "../lib/email/gate.mjs";
import { buildReport, compareWithPool, gradedPool, strengthsAndFixes } from "../lib/grader/report.mjs";
import { completeJob, recordCapture } from "../lib/grader/finish.mjs";
import { checkOwnKey, gradeOnOwnKey, validOwnKey } from "../lib/grader/own-key.mjs";
import { queueFreeGrade } from "../lib/grader/queue.mjs";
import { publicJob } from "../lib/grader/view.mjs";
import { budgetPlan } from "../pipeline/budget.mjs";
import { BACKUP_MODEL, PRIMARY_MODEL } from "../pipeline/gemini.mjs";
import { AI_CRITERIA, gradeRecord, parseRubricResponse } from "../pipeline/rubric.mjs";
import { drainPeopleQueue } from "../pipeline/people.mjs";

const SECRET = "test-secret-not-real";
const T0 = Date.parse("2026-11-10T20:00:00Z"); // noon Pacific

async function tempDb() {
  // A busy timeout like lib/db.ts: concurrent writers wait for the lock instead of failing.
  const db = createClient({ url: `file:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grader-")), "db.sqlite")}`, timeout: 5000 });
  await migrate(db);
  return db;
}

const answer = (over = {}) => ({ is_portfolio: true, tier: "B", ...Object.fromEntries(AI_CRITERIA.map((c) => [c.id, { score: 3, note: `${c.id} note` }])), roles: ["frontend developer"], ...over });
const grade = (over = {}, facts = { resume: false, github: true, contact: true, own_domain: true, template: null, footer_year: 2026, project_links: { checked: 3, ok: 3, broken: 0, blocked: 0 } }) =>
  gradeRecord({ parsed: parseRubricResponse(answer(over)), model: PRIMARY_MODEL, facts, source: "r2", now: new Date(T0) });
const gemini200 = (json) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 80 } }), { status: 200 });

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------
test("addresses: http(s) on the standard ports only, public names only, query and fragment dropped", () => {
  const ok = normalizeGradeUrl("Jane.Dev/Work/?utm=x#top");
  assert.equal(ok.ok, true);
  assert.equal(ok.url, "https://jane.dev/Work");
  assert.equal(ok.siteKey, "jane.dev/work");
  assert.equal(normalizeGradeUrl("http://www.jane.dev:80/").url, "http://www.jane.dev/");
  assert.equal(normalizeGradeUrl("https://jane.dev:443").ok, true);
  assert.equal(siteKeyOf("http://www.jane.dev/"), siteKeyOf("https://jane.dev"));
  for (const [input, error] of [
    ["", "url_required"],
    ["ftp://jane.dev", "bad_scheme"],
    ["javascript:alert(1)", "bad_scheme"],
    ["file:///etc/passwd", "bad_scheme"],
    ["https://jane.dev:8080/", "bad_port"],
    ["https://user:pw@jane.dev/", "bad_url"],
    ["https://127.0.0.1/", "ip_address"],
    ["https://2130706433/", "ip_address"],
    ["https://[::1]/", "ip_address"],
    ["https://169.254.169.254/latest/meta-data/", "ip_address"],
    ["https://localhost/", "bad_host"],
    ["https://printer.local/", "private_address"],
    ["https://metadata.google.internal/", "private_address"],
    ["https://jane dev/", "bad_url"],
    [`https://jane.dev/${"a".repeat(600)}`, "url_too_long"],
  ]) {
    const r = normalizeGradeUrl(input);
    assert.equal(r.ok, false, input);
    assert.equal(r.error, error, input);
    assert.ok(r.message, input);
  }
});

test("networks: an IPv4 address is its own network, IPv6 is grouped by /64; private IPs are not public", () => {
  assert.equal(networkOf("203.0.113.9"), "203.0.113.9");
  assert.equal(networkOf("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(networkOf("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(networkOf("2001:db8:1:2:bbbb:cccc:dddd:eeee"), "2001:db8:1:2::/64");
  assert.equal(networkOf("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(networkOf(""), "");
  for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "100.64.0.1"]) assert.equal(isPublicIp(ip), false, ip);
  for (const ip of ["93.184.216.34", "2606:4700::6810:84e5", "::ffff:8.8.8.8"]) assert.equal(isPublicIp(ip), true, ip);
});

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------
test("caps: all three counters are taken together or not at all, per Pacific day", async () => {
  const db = await tempDb();
  const caps = { ...DEFAULT_CAPS, visitor: 2, network: 3, site: 4 };
  const now = new Date(T0);
  assert.equal((await reserveCaps(db, { visitor: "v1", network: "n1", now, caps })).ok, true);
  assert.equal((await reserveCaps(db, { visitor: "v1", network: "n1", now, caps })).ok, true);
  const over = await reserveCaps(db, { visitor: "v1", network: "n1", now, caps });
  assert.deepEqual([over.ok, over.scope], [false, "visitor"]);
  // The refused request counted nothing: a new visitor on the same network still has the network's third.
  assert.equal((await reserveCaps(db, { visitor: "v2", network: "n1", now, caps })).ok, true);
  const net = await reserveCaps(db, { visitor: "v3", network: "n1", now, caps });
  assert.deepEqual([net.ok, net.scope], [false, "network"]);
  assert.equal((await reserveCaps(db, { visitor: "v4", network: "n2", now, caps })).ok, true);
  const site = await reserveCaps(db, { visitor: "v5", network: "n3", now, caps });
  assert.deepEqual([site.ok, site.scope], [false, "site"]);
  // The next Pacific day starts fresh (08:00 UTC is midnight Pacific in November).
  assert.equal((await reserveCaps(db, { visitor: "v1", network: "n1", now: new Date("2026-11-11T08:30:00Z"), caps })).ok, true);
  const rows = (await db.execute("SELECT k, n FROM grade_caps WHERE day = '2026-11-10' ORDER BY k")).rows.map((r) => `${r.k}=${r.n}`);
  assert.deepEqual(rows, ["2026-11-10|network|n1=3", "2026-11-10|network|n2=1", "2026-11-10|site|all=4", "2026-11-10|visitor|v1=2", "2026-11-10|visitor|v2=1", "2026-11-10|visitor|v4=1"]);
});

test("caps: concurrent requests can't pass the site-wide cap together (cost abuse)", async () => {
  const db = await tempDb();
  const caps = { ...DEFAULT_CAPS, visitor: 100, network: 100, site: 5 };
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => reserveCaps(db, { visitor: `v${i}`, network: `n${i}`, now: new Date(T0), caps }).catch(() => ({ ok: false, scope: "busy" }))));
  assert.equal(results.filter((r) => r.ok).length, 5);
  assert.equal(Number((await db.execute("SELECT n FROM grade_caps WHERE k = '2026-11-10|site|all'")).rows[0].n), 5);
  assert.equal(await reserveSite(db, { day: "2026-11-10", caps }), false);
  assert.equal(await reserveSite(db, { day: "2026-11-11", caps }), true);
  assert.deepEqual(graderCaps('{"visitor":1,"site":"x","waiting":-4}'), { ...DEFAULT_CAPS, visitor: 1, waiting: 0 });
  assert.deepEqual(graderCaps("not json"), DEFAULT_CAPS);
});

// ---------------------------------------------------------------------------
// Jobs, cooldown, claims
// ---------------------------------------------------------------------------
test("job ids are 128 random bits, URL-safe", () => {
  const ids = new Set(Array.from({ length: 200 }, newJobId));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, JOB_ID);
});

test("re-grade cooldown: once every 7 days, sooner when the page changed, never two at once", async () => {
  const db = await tempDb();
  const base = { url: "https://jane.dev/", siteKey: "jane.dev", quickFingerprint: "fp1" };
  assert.deepEqual(await regradeCheck(db, { siteKey: "jane.dev", now: T0 }), { allowed: true });
  const id = await createJob(db, { ...base, status: "capturing", now: T0 });
  const busy = await regradeCheck(db, { siteKey: "jane.dev", quickFingerprint: "fp1", now: T0 + 60000 });
  assert.deepEqual([busy.allowed, busy.error, busy.jobId], [false, "in_progress", id]);
  await setJob(db, id, { status: "done", done_at: new Date(T0).toISOString() }, { now: T0 });
  const cool = await regradeCheck(db, { siteKey: "jane.dev", quickFingerprint: "fp1", now: T0 + 86400000 });
  assert.deepEqual([cool.allowed, cool.error, cool.nextAt], [false, "cooldown", new Date(T0 + 7 * 86400000).toISOString()]);
  assert.equal((await regradeCheck(db, { siteKey: "jane.dev", quickFingerprint: "fp2", now: T0 + 86400000 })).allowed, true, "the page changed");
  assert.equal((await regradeCheck(db, { siteKey: "jane.dev", quickFingerprint: "fp1", now: T0 + 7 * 86400000 })).allowed, true, "cooldown over");
  // A failed job doesn't hold the cooldown.
  await setJob(db, id, { status: "failed" }, { now: T0 });
  assert.equal((await regradeCheck(db, { siteKey: "jane.dev", quickFingerprint: "fp1", now: T0 + 3600000 })).allowed, true);
});

test("captures are claimed once: two runs never take the same job, and a stale claim is taken over", async () => {
  const db = await tempDb();
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await createJob(db, { url: `https://s${i}.dev/`, siteKey: `s${i}.dev`, status: "capturing", now: T0 + i }));
  await createJob(db, { url: "https://w.dev/", siteKey: "w.dev", status: "waiting", now: T0 });
  const [a, b] = await Promise.all([claimCaptures(db, { runId: "a", limit: 3, now: T0 + 10 }), claimCaptures(db, { runId: "b", limit: 3, now: T0 + 10 })]);
  const all = [...a, ...b].map((j) => j.id);
  assert.equal(new Set(all).size, all.length, "no job claimed twice");
  assert.deepEqual(all.sort(), [...ids].sort());
  assert.equal((await claimCaptures(db, { runId: "c", now: T0 + 60000 })).length, 0);
  assert.equal((await claimCaptures(db, { runId: "c", limit: 10, now: T0 + 21 * 60000 })).length, 4, "claims older than 20 minutes are taken over");
});

// ---------------------------------------------------------------------------
// Dispatch (mocked GitHub)
// ---------------------------------------------------------------------------
function github() {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization });
      return new Response(JSON.stringify({ workflow_run_id: 77, html_url: "https://github.test/run/77" }), { status: 200 });
    },
  };
}

test("dispatch: no token is a clear state; a dispatch carries no job id, and a burst rides on one run", async () => {
  const db = await tempDb();
  const a = await createJob(db, { url: "https://a.dev/", siteKey: "a.dev", status: "capturing", now: T0 });
  assert.equal(await startCapture(db, a, { token: undefined, now: T0 }), "unavailable");
  assert.equal((await readJob(db, a)).reason, NO_TOKEN_REASON);

  const gh = github();
  const b = await createJob(db, { url: "https://b.dev/", siteKey: "b.dev", status: "capturing", now: T0 });
  await startCapture(db, b, { token: "t", fetchImpl: gh.fetchImpl, apiBase: "https://api.github.test", now: T0 });
  assert.equal(gh.calls.length, 1);
  assert.match(gh.calls[0].url, /\/repos\/n8watkins\/portfolio-rank\/actions\/workflows\/grade\.yml\/dispatches$/);
  assert.deepEqual(gh.calls[0].body.inputs, {}, "the public run shows no job id");
  assert.ok(!JSON.stringify(gh.calls[0].body).includes(b));
  const c = await createJob(db, { url: "https://c.dev/", siteKey: "c.dev", status: "capturing", now: T0 + 1000 });
  await startCapture(db, c, { token: "t", fetchImpl: gh.fetchImpl, apiBase: "https://api.github.test", now: T0 + 1000 });
  assert.equal(gh.calls.length, 1, "coalesced with the run dispatched a second ago");
  assert.equal((await readJob(db, c)).dispatch_run, "coalesced");
});

test("dispatch: a capture GitHub doesn't start is dispatched again, at most 3 times, then fails", async () => {
  const db = await tempDb();
  const gh = github();
  const id = await createJob(db, { url: "https://a.dev/", siteKey: "a.dev", status: "capturing", now: T0 });
  await startCapture(db, id, { token: "t", fetchImpl: gh.fetchImpl, now: T0 });
  assert.deepEqual(await retryStalled(db, { token: "t", fetchImpl: gh.fetchImpl, now: T0 + 5 * 60000 }), { redispatched: 0, failed: 0 });
  let t = T0;
  for (let i = 1; i < MAX_DISPATCHES; i++) {
    t += 11 * 60000;
    // Two isolates at once dispatch it only once.
    const [r1, r2] = await Promise.all([retryStalled(db, { token: "t", fetchImpl: gh.fetchImpl, now: t }), retryStalled(db, { token: "t", fetchImpl: gh.fetchImpl, now: t })]);
    assert.equal(r1.redispatched + r2.redispatched, 1);
  }
  assert.equal(gh.calls.length, MAX_DISPATCHES);
  const last = await retryStalled(db, { token: "t", fetchImpl: gh.fetchImpl, now: t + 11 * 60000 });
  assert.deepEqual(last, { redispatched: 0, failed: 1 });
  assert.equal((await readJob(db, id)).status, "failed");
});

// ---------------------------------------------------------------------------
// One-time links and the owner cookie
// ---------------------------------------------------------------------------
test("links: signed, expiring and one-time; forged or altered tokens are refused", async () => {
  const db = await tempDb();
  const jobId = newJobId();
  const { token } = await createLinkToken(db, { jobId, secret: SECRET, now: T0 });
  assert.deepEqual(await openLinkToken(db, token, { secret: "other", now: T0 }), { ok: false, error: "bad" });
  const [payload, sig] = token.split(".");
  const forged = `${Buffer.from(JSON.stringify({ j: newJobId(), n: "x", e: T0 + 1e9 })).toString("base64url")}.${sig}`;
  assert.equal((await openLinkToken(db, forged, { secret: SECRET, now: T0 })).error, "bad");
  assert.equal((await openLinkToken(db, `${payload}.`, { secret: SECRET, now: T0 })).error, "bad");
  assert.deepEqual(await openLinkToken(db, token, { secret: SECRET, now: T0 + 1000 }), { ok: true, jobId });
  assert.deepEqual(await openLinkToken(db, token, { secret: SECRET, now: T0 + 2000 }), { ok: false, error: "used", jobId });
  const late = await createLinkToken(db, { jobId, secret: SECRET, now: T0 });
  assert.deepEqual(await openLinkToken(db, late.token, { secret: SECRET, now: T0 + 8 * 86400000 }), { ok: false, error: "expired", jobId });
  // Only a hash of the nonce is stored.
  const stored = (await db.execute("SELECT nonce_hash FROM grade_links")).rows.map((r) => String(r.nonce_hash));
  const nonce = JSON.parse(Buffer.from(payload, "base64url").toString()).n;
  assert.ok(!stored.includes(nonce));
});

test("owner cookie: signed list of report ids; forged cookies own nothing", () => {
  const ids = [newJobId(), newJobId()];
  const v = ownerCookieValue([...ids, "not-an-id"], SECRET);
  assert.deepEqual(readOwnerCookie(v, SECRET), ids);
  assert.deepEqual(readOwnerCookie(v, "other"), []);
  const [, sig] = v.split(".");
  assert.deepEqual(readOwnerCookie(`${Buffer.from(newJobId()).toString("base64url")}.${sig}`, SECRET), []);
  const many = Array.from({ length: 30 }, newJobId);
  assert.deepEqual(readOwnerCookie(ownerCookieValue(many, SECRET), SECRET), many.slice(-20));
});

// ---------------------------------------------------------------------------
// The email gate
// ---------------------------------------------------------------------------
function outbox() {
  const sent = [];
  return { sent, transport: { name: "test", send: async (m) => void sent.push(m) } };
}

test("email gate: hard daily, per-kind and per-recipient caps; refused and failed sends count; no address stored", async () => {
  const db = await tempDb();
  const box = outbox();
  const gate = createEmailGate({ db, transport: box.transport, caps: { day: 5, perRecipient: 2, kinds: { "grade-report": 4 } }, secret: SECRET, now: () => new Date(T0) });
  const send = (to, kind = "grade-report") => gate.send({ kind, to, subject: "s", text: "t" });
  assert.deepEqual(await send("a@example.com"), { sent: true });
  assert.deepEqual(await send("A@Example.com "), { sent: true });
  assert.deepEqual(await send("a@example.com"), { sent: false, reason: "cap:recipient" });
  assert.deepEqual(await send("b@example.com"), { sent: true });
  assert.deepEqual(await send("c@example.com"), { sent: true });
  assert.deepEqual(await send("d@example.com"), { sent: false, reason: "cap:kind" });
  assert.deepEqual(await send("owner@example.com", "owner-alert"), { sent: true });
  assert.deepEqual(await send("owner2@example.com", "owner-alert"), { sent: false, reason: "cap:day" });
  assert.deepEqual(await send("not an address"), { sent: false, reason: "bad_address" });
  assert.equal(box.sent.length, 5);
  const rows = (await db.execute("SELECT * FROM email_sends")).rows;
  assert.ok(!JSON.stringify(rows).includes("example.com"), "the log holds hashes, never addresses");
  assert.equal(rows[0].to_hash, addressHash("a@example.com", SECRET));

  // A failing provider counts too, so it can't become a retry storm.
  const db2 = await tempDb();
  const broken = createEmailGate({ db: db2, transport: { name: "x", send: async () => { throw new Error("provider down for a@example.com"); } }, caps: { day: 2, perRecipient: 5, kinds: {} }, secret: SECRET });
  const r = await broken.send({ kind: "grade-report", to: "a@example.com", subject: "s", text: "t" });
  assert.equal(r.sent, false);
  assert.match(r.reason, /^error: provider down for \[email\]/);
  await broken.send({ kind: "grade-report", to: "b@example.com", subject: "s", text: "t" });
  assert.deepEqual(await broken.send({ kind: "grade-report", to: "c@example.com", subject: "s", text: "t" }), { sent: false, reason: "cap:day" });
  assert.deepEqual(await createEmailGate({ db: db2, transport: null }).send({ kind: "grade-report", to: "a@example.com", subject: "s", text: "t" }), { sent: false, reason: "no_transport" });
});

test("email transport: the send_email binding from EMAIL_FROM; the test outbox is refused on deployed Workers", async () => {
  const sent = [];
  const t = emailTransport({ SEND_EMAIL: { send: async (m) => sent.push(m) }, EMAIL_FROM: "portfoliorank@n8builds.dev" });
  await t.send({ to: "a@example.com", subject: "s", text: "t" });
  assert.deepEqual(sent[0].from, { email: "portfoliorank@n8builds.dev", name: "PortfolioRank" });
  assert.equal(emailTransport({ SEND_EMAIL: { send() {} } }), null, "no sender address, no transport");
  assert.equal(emailTransport({}), null);
  assert.throws(() => emailTransport({ EMAIL_TRANSPORT: "outbox", SITE_ENV: "production" }, { db: {} }), /test runs only/);
  for (const bad of ["a@b", "a b@example.com", "a@example.com\nBcc: x@example.com", "<a@example.com>", "a@example.com, b@example.com"]) assert.equal(validEmail(bad), null, bad);
  assert.equal(validEmail(" jane.doe+pr@example.co.uk "), "jane.doe+pr@example.co.uk");
});

// ---------------------------------------------------------------------------
// Report emails
// ---------------------------------------------------------------------------
test("report emails: sent once the report is ready, through the gate, with a one-time link; the address is then erased", async () => {
  const db = await tempDb();
  const box = outbox();
  const gate = createEmailGate({ db, transport: box.transport, secret: SECRET });
  const id = await createJob(db, { url: "https://jane.dev/", siteKey: "jane.dev", status: "queued", now: T0 });
  assert.deepEqual(await requestEmail(db, { jobId: id, email: "Jane@Example.com", secret: SECRET }), { ok: true, duplicate: false });
  assert.deepEqual(await requestEmail(db, { jobId: id, email: "jane@example.com", secret: SECRET }), { ok: true, duplicate: true });
  assert.deepEqual(await requestEmail(db, { jobId: id, email: "x", secret: SECRET }), { ok: false, error: "bad_email" });
  await requestEmail(db, { jobId: id, email: "two@example.com", secret: SECRET });
  assert.deepEqual(await requestEmail(db, { jobId: id, email: "three@example.com", secret: SECRET }), { ok: false, error: "too_many" });

  assert.deepEqual(await sendDueEmails(db, { gate, secret: SECRET, base: "https://pr.test", now: T0 }), { sent: 0, refused: 0, gaveUp: 0 }, "nothing while it waits for Gemini");
  await setJob(db, id, { status: "done", result: grade({ tier: "A" }), done_at: new Date(T0).toISOString() }, { now: T0 });
  assert.deepEqual(await sendDueEmails(db, { gate, secret: SECRET, base: "https://pr.test/", now: T0 }), { sent: 2, refused: 0, gaveUp: 0 });
  assert.equal(box.sent.length, 2);
  assert.match(box.sent[0].subject, /jane\.dev is ready/);
  assert.match(box.sent[0].text, /tier A/);
  const link = box.sent[0].text.match(/https:\/\/pr\.test\/api\/grade\/link\?t=(\S+)/);
  assert.ok(link, box.sent[0].text);
  assert.deepEqual(await openLinkToken(db, decodeURIComponent(link[1]), { secret: SECRET }), { ok: true, jobId: id });
  assert.ok(box.sent[0].html.includes("Open my report"));
  const rows = (await db.execute("SELECT email, status FROM grade_emails")).rows;
  assert.deepEqual(rows.map((r) => [r.email, r.status]), [[null, "sent"], [null, "sent"]], "addresses are erased once sent");
  assert.deepEqual(await emailState(db, id), { requested: true, sent: true, waiting: false });
  assert.deepEqual(await sendDueEmails(db, { gate, secret: SECRET, base: "https://pr.test", now: T0 }), { sent: 0, refused: 0, gaveUp: 0 }, "never twice");
  assert.match(reportEmail({ url: "https://jane.dev/", link: "https://x", status: "failed" }).subject, /couldn't grade jane\.dev/);
});

test("report emails: a cap holds them for the next tick; after 3 days the address is given up and erased", async () => {
  const db = await tempDb();
  const box = outbox();
  const gate = createEmailGate({ db, transport: box.transport, caps: { day: 0, perRecipient: 3, kinds: {} }, secret: SECRET });
  const id = await createJob(db, { url: "https://jane.dev/", siteKey: "jane.dev", status: "done", now: T0 });
  await requestEmail(db, { jobId: id, email: "jane@example.com", secret: SECRET, now: T0 });
  assert.deepEqual(await sendDueEmails(db, { gate, secret: SECRET, base: "https://pr.test", now: T0 }), { sent: 0, refused: 1, gaveUp: 0 });
  assert.equal((await db.execute("SELECT email FROM grade_emails")).rows[0].email, "jane@example.com");
  assert.deepEqual(await sendDueEmails(db, { gate, secret: SECRET, base: "https://pr.test", now: T0 + 4 * 86400000 }), { sent: 0, refused: 0, gaveUp: 1 });
  assert.equal((await db.execute("SELECT email FROM grade_emails")).rows[0].email, null);
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------
const poolSite = (i, tier, axes = {}) => ({
  url: `https://site${i}.dev/`,
  name: `Site ${i}`,
  mu: { S: 33, A: 29, B: 25, C: 21, D: 17 }[tier] + (i % 3) * 0.1,
  tier,
  quality: 3,
  axes: { visual_design: 3, five_second_test: 3, storytelling: 3, writing: 3, memorability: 3, ...axes },
  roles: [],
});

test("report: strengths, fixes, percentile, similar portfolios and who does it better, without the site itself", () => {
  const g = grade({ tier: "B", visual_design: { score: 5, note: "clean grid" }, writing: { score: 2, note: "typos" }, storytelling: { score: 2, note: "bare tech lists" } });
  const { strengths, fixes } = strengthsAndFixes(g);
  assert.equal(strengths[0].criterion, "visual_design");
  assert.equal(strengths[0].why, "clean grid");
  // Weighted by how much each costs: two weak AI axes outrank a missing resume link.
  assert.deepEqual(fixes.map((f) => f.criterion), ["storytelling", "writing", "resume"]);
  assert.equal(fixes[2].title, "Link your resume");
  const pool = [
    ...Array.from({ length: 10 }, (_, i) => poolSite(i, "A", i < 2 ? { storytelling: 5 } : {})),
    ...Array.from({ length: 10 }, (_, i) => poolSite(10 + i, "B")),
    ...Array.from({ length: 19 }, (_, i) => poolSite(20 + i, "C")),
    { ...poolSite(99, "S", { writing: 5 }), url: "https://www.jane.dev" },
  ];
  const r = compareWithPool(g, pool, { isSelf: (u) => siteKeyOf(u) === "jane.dev" });
  assert.equal(r.percentile.total, 40, "39 others plus this one");
  assert.ok(r.percentile.rank > 10 && r.percentile.rank <= 21, String(r.percentile.rank));
  assert.ok(r.percentile.topPct >= 1 && r.percentile.topPct <= 100);
  assert.equal(r.similar.length, 4);
  assert.ok(r.similar.every((s) => s.tier === "B"));
  assert.ok(!JSON.stringify(r).includes("jane.dev"), "the site is never its own neighbour");
  const story = r.better.find((b) => b.criterion === "storytelling");
  assert.deepEqual(story.sites.map((s) => s.url).sort(), ["https://site0.dev/", "https://site1.dev/"]);
  assert.ok(r.better.every((b) => b.sites.length > 0));
  const full = buildReport(g, pool);
  assert.equal(full.facts.find((f) => f.id === "resume").pass, false);
  assert.equal(full.judgments.length, AI_CRITERIA.length);
  assert.deepEqual(compareWithPool(g, []).percentile, null);
});

test("report pool: listed, graded portfolios only, cached for an hour", async () => {
  const db = await tempDb();
  const rubric = (tier, extra = {}) => JSON.stringify({ tier, is_portfolio: true, quality_score: 3.5, ...extra });
  await db.batch(
    [
      { sql: "INSERT INTO portfolios (url, name, status, ai_rubric) VALUES (?, ?, 'live', ?)", args: ["https://a.dev/", "A", rubric("A")] },
      { sql: "INSERT INTO portfolios (url, name, status, ai_rubric, delisted_at) VALUES (?, ?, 'live', ?, '2026-01-01')", args: ["https://gone.dev/", "Gone", rubric("S")] },
      { sql: "INSERT INTO portfolios (url, name, status, ai_rubric) VALUES (?, ?, 'live', ?)", args: ["https://np.dev/", "NP", rubric("C", { is_portfolio: false })] },
      { sql: "INSERT INTO portfolios (url, name, status, ai_rubric) VALUES (?, ?, 'live', ?)", args: ["https://err.dev/", "Err", JSON.stringify({ error: "no_usable_captures" })] },
      { sql: "INSERT INTO portfolios (url, name, status) VALUES (?, ?, 'live')", args: ["https://ungraded.dev/", "U"] },
    ],
    "write"
  );
  const pool = await gradedPool(db, { now: T0 });
  assert.deepEqual(pool.map((p) => p.url), ["https://a.dev/"]);
  await db.execute({ sql: "INSERT INTO portfolios (url, name, status, ai_rubric) VALUES (?, ?, 'live', ?)", args: ["https://b.dev/", "B", rubric("B")] });
  assert.equal((await gradedPool(db, { now: T0 + 60000 })).length, 1, "cached");
  assert.equal((await gradedPool(db, { now: T0 + 61 * 60000 })).length, 2, "refreshed after an hour");
});

// ---------------------------------------------------------------------------
// Own key (mocked Gemini)
// ---------------------------------------------------------------------------
const KEY = `AIza${"x".repeat(35)}`;

test("own key: used only in Google's header, 3.5 only, same rubric, marked own-key; errors never echo the key", async () => {
  assert.equal(validOwnKey(KEY), true);
  assert.equal(validOwnKey("AQ.Ab8RN6" + "y".repeat(40)), true);
  for (const bad of ["", "sk-123", "AIza short", `AIza${"x".repeat(35)}\n`]) assert.equal(validOwnKey(bad), bad.trim() === KEY, JSON.stringify(bad));

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: String(init.body ?? "") });
    return gemini200(answer({ tier: "A" }));
  };
  const job = { url: "https://jane.dev/", final_url: "https://jane.dev/", page_text: "Jane, frontend developer. Mail jane@example.com", facts: { github: true }, meta: { motion: false } };
  const r = await gradeOnOwnKey({ key: KEY, job, image: { inline_data: { mime_type: "image/jpeg", data: "AAAA" } }, fetchImpl, now: () => T0, sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.grade.own_key, true);
  assert.equal(r.grade.grading_source, "own-key");
  assert.equal(r.grade.model, PRIMARY_MODEL);
  assert.equal(r.grade.facts.motion, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /models\/gemini-3\.5-flash-lite:generateContent$/);
  assert.ok(!calls[0].url.includes(KEY), "never in the URL");
  assert.equal(calls[0].headers["x-goog-api-key"], KEY);
  assert.ok(!calls[0].body.includes("jane@example.com"), "contact details are stripped before Gemini");
  assert.ok(!calls[0].body.includes(KEY));

  const fail = (status, text) => async () => new Response(text, { status });
  const o = { key: KEY, job, image: null, now: () => T0, sleep: async () => {} };
  assert.deepEqual(await gradeOnOwnKey({ ...o, fetchImpl: fail(400, `{"error":{"message":"API key not valid ${KEY}","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}`) }), { ok: false, error: "own_key_rejected" });
  assert.deepEqual(await gradeOnOwnKey({ ...o, fetchImpl: fail(429, '{"error":{"details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}') }), { ok: false, error: "own_key_quota" });
  assert.deepEqual(await gradeOnOwnKey({ ...o, fetchImpl: fail(503, "overloaded") }), { ok: false, error: "gemini_busy" });
  assert.deepEqual(await gradeOnOwnKey({ ...o, fetchImpl: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "MAX_TOKENS" }] }), { status: 200 }) }), { ok: false, error: "grade_failed" });

  assert.equal(await checkOwnKey(KEY, { fetchImpl: async () => new Response("{}", { status: 200 }) }), "ok");
  assert.equal(await checkOwnKey(KEY, { fetchImpl: async () => new Response("{}", { status: 400 }) }), "rejected");
  assert.equal(await checkOwnKey(KEY, { fetchImpl: async () => { throw new Error("down"); } }), "unknown");
});

// ---------------------------------------------------------------------------
// Free tier through the people queue (mocked Gemini)
// ---------------------------------------------------------------------------
function peopleCtx(db, { quota = 500, respond }) {
  const clock = { t: T0 };
  const calls = [];
  return {
    calls,
    clock,
    ctx: {
      db,
      apiKey: "test-key-not-real",
      plan: budgetPlan(),
      quota: { [PRIMARY_MODEL]: quota, [BACKUP_MODEL]: 500 },
      rpm: 60,
      now: () => clock.t,
      sleep: async (ms) => void (clock.t += ms),
      log: () => {},
      fetchImpl: async (url) => {
        calls.push(String(url));
        return respond(calls.length - 1);
      },
      image: async () => ({ inline_data: { mime_type: "image/jpeg", data: "AAAA" } }),
      email: null,
      runId: "test",
    },
  };
}

async function capturedJob(db, { ownKey = false } = {}) {
  const id = await createJob(db, { url: "https://jane.dev/", siteKey: "jane.dev", status: "capturing", ownKey, now: T0 });
  const status = await recordCapture(db, id, { finalUrl: "https://jane.dev/", shotKey: shotKeyOf(id), pageText: "Jane builds things.", facts: { github: true, resume: false }, meta: { motion: true, domHash: "d", classHash: "c" }, now: T0 });
  return { id, status };
}

test("free tier: the capture lands, 3.5 grades it as a person's request, and the job gets its report", async () => {
  const db = await tempDb();
  const { id, status } = await capturedJob(db);
  assert.equal(status, "grading");
  const { ctx, calls } = peopleCtx(db, { respond: () => gemini200(answer({ tier: "A" })) });
  assert.equal(await queueFreeGrade(ctx, await readJob(db, id)), "done");
  assert.equal(calls.length, 1, "one Gemini request per grade");
  assert.match(calls[0], /gemini-3\.5-flash-lite/);
  const job = await readJob(db, id);
  assert.equal(job.status, "done");
  assert.equal(job.result.tier, "A");
  assert.deepEqual(job.result.roles, ["frontend developer"]);
  assert.equal(job.result.facts.motion, true, "motion from the capture reaches the grade");
  assert.ok(job.report.fixes.length > 0);
  const log = (await db.execute("SELECT job, model FROM gemini_requests")).rows;
  assert.deepEqual(log.map((r) => [r.job, r.model]), [["people-grade", PRIMARY_MODEL]], "counted by the budget accountant as people's work");
  const view = publicJob(job, { mine: true });
  assert.equal(view.report.tier, "A");
  assert.equal(view.steps.every((s) => s.state === "done"), true);
  assert.ok(!JSON.stringify(view).includes("Jane builds things"), "page text never leaves the server");
});

test("free tier: a spent quota queues the grade (no 3.1), and the hourly drain finishes it and the job", async () => {
  const db = await tempDb();
  const { id } = await capturedJob(db);
  const quota429 = () => new Response('{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}', { status: 429 });
  const first = peopleCtx(db, { respond: quota429 });
  assert.equal(await queueFreeGrade(first.ctx, await readJob(db, id)), "queued");
  assert.ok(first.calls.every((u) => u.includes("gemini-3.5-flash-lite")), "never a fallback to 3.1");
  let job = await readJob(db, id);
  assert.equal(job.status, "queued");
  assert.match(job.reason, /email/);
  const later = peopleCtx(db, { respond: () => gemini200(answer()) });
  later.clock.t = T0 + 3600000;
  assert.deepEqual(await drainPeopleQueue(later.ctx), { done: 1, queued: 0, failed: 0 });
  job = await readJob(db, id);
  assert.equal(job.status, "done");
  // No Gemini key on this side: the request waits for the drain.
  const db2 = await tempDb();
  const second = await capturedJob(db2);
  const noKey = peopleCtx(db2, { respond: () => gemini200(answer()) });
  noKey.ctx.apiKey = undefined;
  assert.equal(await queueFreeGrade(noKey.ctx, await readJob(db2, second.id)), "queued");
  assert.equal(noKey.calls.length, 0);
});

test("own-key jobs wait for the visitor's key after the capture; completing one writes no request log row", async () => {
  const db = await tempDb();
  const { id, status } = await capturedJob(db, { ownKey: true });
  assert.equal(status, "awaiting_key");
  const job = await readJob(db, id);
  assert.equal(publicJob(job).steps.find((s) => s.key === "grade").state, "needs_key");
  const r = await gradeOnOwnKey({ key: KEY, job, image: null, fetchImpl: async () => gemini200(answer()), now: () => T0, sleep: async () => {} });
  await completeJob(db, id, { grade: r.grade, pool: [] });
  const done = await readJob(db, id);
  assert.equal(done.status, "done");
  assert.equal(publicJob(done).report.ownKey, true);
  await (await import("../pipeline/gemini-log.mjs")).ensureGeminiLog(db);
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM gemini_requests")).rows[0].n), 0, "the visitor's quota, not ours");
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
test("config: the grader ships off everywhere, the tick is scheduled in production only, email has its binding and sender", async () => {
  const { parseJsonc } = await import("../scripts/check-worker-exports.mjs");
  const config = parseJsonc(fs.readFileSync("wrangler.jsonc", "utf8"));
  for (const env of [config, config.env.staging]) {
    assert.equal(env.vars.GRADER_ENABLED, "false");
    assert.equal(env.vars.EMAIL_FROM, "portfoliorank@n8builds.dev");
    assert.deepEqual(env.send_email, [{ name: "SEND_EMAIL" }]);
  }
  assert.ok(config.triggers.crons.includes("*/5 * * * *"));
  assert.deepEqual(config.env.staging.triggers.crons, []);
  const workflow = fs.readFileSync(".github/workflows/grade.yml", "utf8");
  assert.match(workflow, /on:\n  workflow_dispatch:\n\n/, "no inputs: the run's page is public");
  assert.doesNotMatch(workflow, /schedule:|inputs\./);
  assert.match(workflow, /GEMINI_FALLBACK: "off"/);
});

test("Turnstile: skipped without a secret; with one, a token for another action or a failed check is refused", async () => {
  const { verifyTurnstile } = await import("../lib/turnstile.ts");
  const saved = process.env.TURNSTILE_SECRET_KEY;
  try {
    delete process.env.TURNSTILE_SECRET_KEY;
    assert.equal(await verifyTurnstile(undefined, "", { action: "grade" }), "skipped");
    process.env.TURNSTILE_SECRET_KEY = "turnstile-test-secret";
    const answer = (body) => async (url, init) => {
      assert.equal(String(url), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
      assert.equal(init.body.get("secret"), "turnstile-test-secret");
      return new Response(JSON.stringify(body));
    };
    assert.equal(await verifyTurnstile(undefined, "", { action: "grade", fetchImpl: answer({ success: true }) }), "failed", "a missing token");
    assert.equal(await verifyTurnstile("tok", "203.0.113.1", { action: "grade", fetchImpl: answer({ success: true, action: "grade" }) }), "ok");
    assert.equal(await verifyTurnstile("tok", "", { action: "grade", fetchImpl: answer({ success: true, action: "poll-vote" }) }), "failed");
    assert.equal(await verifyTurnstile("tok", "", { action: "grade", fetchImpl: answer({ success: false }) }), "failed");
    assert.equal(await verifyTurnstile("tok", "", { action: "grade", fetchImpl: async () => { throw new Error("down"); } }), "failed", "fails closed");
  } finally {
    if (saved === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = saved;
  }
});
