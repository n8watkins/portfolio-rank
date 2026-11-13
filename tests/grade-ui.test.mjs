// Browser tests for "grade my portfolio" (app/grade, app/grade/[id], app/claim)
// against the production build scripts/test-e2e.sh starts with GRADER_ENABLED
// and GAMES_V2 on. A grade starts from the /grade form for real, with a local
// stand-in for the portfolio site and GitHub's dispatch API (as
// tests/grader-api.test.mjs does); the test then finishes it in the database
// the way the grade workflow would.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { createClient } from "@libsql/client";
import { ADMIN_ID, sessionToken } from "./helpers/session.mjs";
import { AI_CRITERIA } from "../pipeline/rubric.mjs";
import { buildReport } from "../lib/grader/report.mjs";
import { CELEBRATIONS, celebrationLevel } from "../lib/grader/present.mjs";
import { NO_TOKEN_REASON } from "../lib/grader/dispatch.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const MOCK_PORT = Number(process.env.E2E_GRADER_MOCK_PORT ?? 7693);
const grading = process.env.GRADER_ENABLED === "true";
const games = process.env.GAMES_V2 === "true";
const db = createClient({ url: DB_URL, timeout: 10000 });
const feed = JSON.parse(readFileSync("data/feed.json", "utf8"));
const RUN = Math.random().toString(36).slice(2, 8);
// A listed portfolio no other test grades or claims.
const LISTED = feed[171].url;
let browser;
let mock;
let ipSeq = 1;

const page = (title) => `<!doctype html><html><head><title>${title}</title></head><body>
<h1>${title}</h1><p>I build calm, fast interfaces.</p>
<a href="https://github.com/grade-ui">GitHub</a> <a href="mailto:ui@example.com">Email</a>
<footer>© 2026 ${title}</footer></body></html>`;

before(async () => {
  mock = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
    req.resume();
    req.on("end", () => {
      if (url.pathname === "/site") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Grade UI Tester"));
      if (url.pathname.endsWith("/dispatches")) return res.writeHead(200, { "content-type": "application/json" }).end('{"workflow_run_id":1}');
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE + "/api/rank")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  mock?.close();
});

async function freshPage(width, height = 900, options = {}) {
  // Each visitor its own network, so the per-network daily cap never mixes tests.
  const context = await browser.newContext({ viewport: { width, height }, extraHTTPHeaders: { "cf-connecting-ip": `192.0.2.${ipSeq++}` }, ...options });
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  p.on("console", (m) => m.type() === "error" && !/Failed to load resource|turnstile|challenges\.cloudflare/i.test(m.text()) && errors.push(m.text()));
  return { page: p, context, errors };
}

/** Starts a grade from the /grade form and returns its id once the progress page shows. */
async function startGrade(p, address) {
  await p.goto(BASE + "/grade");
  await p.getByRole("heading", { level: 1, name: /How good is your portfolio/ }).waitFor();
  const form = p.locator("#grade form");
  await form.getByLabel("Your portfolio address").fill(address);
  await form.getByRole("button", { name: "Grade it" }).click();
  await p.waitForURL(/\/grade\/[A-Za-z0-9_-]{22}$/, { timeout: 20000 });
  return new URL(p.url()).pathname.split("/").pop();
}

const pool = feed.slice(300, 312).map((f, i) => ({
  url: f.url,
  name: f.name,
  mu: i < 6 ? 40 - i : 20 - i,
  tier: i < 6 ? "A" : "B",
  // Rank keys (lib/tiers.mjs): one portfolio above the graded one, eleven below, so its report is 2nd of 13: tier A.
  key: i === 0 ? 999999 : 1000 - i,
  quality: 4,
  axes: Object.fromEntries(AI_CRITERIA.map((c) => [c.id, 5])),
  roles: ["designer"],
}));

/** The grade workflow's part: the capture lands and Gemini grades it. */
async function finish(id, { perfect = false } = {}) {
  const grade = {
    is_portfolio: true,
    tier: perfect ? "S" : "A",
    roles: ["designer"],
    rubric_version: 2,
    model: "gemini-3.5-flash-lite",
    checks: perfect
      ? { github: true, contact: true, resume: true, own_domain: true, fresh_footer: true, project_links: true, original: true }
      : { github: true, contact: true, resume: false, own_domain: true, fresh_footer: true, project_links: true, original: true },
    facts: { footer_year: 2026, project_links: { checked: 2, ok: 2, broken: 0 } },
    ...Object.fromEntries(AI_CRITERIA.map((c) => [c.id, { score: perfect ? 5 : c.id === "storytelling" ? 3 : 4, note: `${c.name} note` }])),
    judged_at: new Date().toISOString(),
  };
  const report = buildReport(grade, pool, {});
  const now = new Date().toISOString();
  await db.execute({
    sql: "UPDATE grade_jobs SET status = 'done', reason = NULL, result = ?, report = ?, done_at = ?, captured_at = ? WHERE id = ?",
    args: [JSON.stringify(grade), JSON.stringify(report), now, now, id],
  });
}

let reportId = null;

test("grade yours: the form, the progress page, then the report as approved", { skip: !grading }, async () => {
  const { page: p, context, errors } = await freshPage(1440);
  const id = await startGrade(p, `grade-ui-${RUN}.dev`);
  reportId = id;

  // Progress, live from GET /api/grade/<id>.
  await p.getByRole("heading", { level: 1, name: `grade-ui-${RUN}.dev` }).waitFor();
  const bar = p.getByRole("progressbar", { name: "Grade progress" });
  assert.equal(await bar.getAttribute("aria-valuenow"), "1", "the free checks are done at once");
  await p.getByText("Opening the page and taking screenshots").waitFor();
  await p.getByText(/Grades run on Google Gemini's free tier/).waitFor();
  await p.getByRole("heading", { name: "Get it by email, no account needed" }).waitFor();
  const res = await p.request.get(`${BASE}/grade/${id}`);
  assert.equal(res.headers()["x-robots-tag"], "noindex, nofollow", "reports are never indexed");
  assert.match(await p.locator('meta[name="robots"]').getAttribute("content"), /noindex/);

  await finish(id);
  // The page notices on its next look and turns into the report.
  await p.getByRole("heading", { level: 1, name: "Grade UI Tester" }).waitFor({ timeout: 15000 });
  // The tier is a starting rank from automated checks (votes move it later). The verdict and "top N%" are the grade's (Gemini's A).
  const tierImg = p.locator("#report-tier").getByRole("img", { name: /^Tier / });
  await tierImg.waitFor();
  const tierName = await tierImg.getAttribute("aria-label");
  await p.getByText("Starting rank from automated checks").waitFor();
  await p.getByText("Strong and clear, with a few rough edges.").waitFor();
  assert.match(await p.getByText(/^GradeTop \d+%$/).first().textContent(), /Top \d+%/);

  // The owner's result is celebrated by its level, once per report in this browser.
  const stored = JSON.parse(String((await db.execute({ sql: "SELECT report FROM grade_jobs WHERE id = ?", args: [id] })).rows[0].report));
  const level = celebrationLevel({ tier: stored.rank?.tier, percentile: stored.percentile });
  if (level) {
    const banner = p.getByRole("status").filter({ hasText: `${CELEBRATIONS[level].title}!` });
    await banner.waitFor();
    await banner.getByRole("button", { name: "Dismiss" }).click();
    await p.reload();
    await p.locator("#report-tier").getByRole("img", { name: tierName }).waitFor();
    await p.waitForTimeout(800);
    assert.equal(await banner.count(), 0);
  }

  // A report, not a sales page: the fixes in order, then the findings, dense.
  const fixes = p.getByRole("region", { name: "Fix these, in order" });
  assert.match(await fixes.textContent(), /Expected:/);
  const hiring = p.getByRole("region", { name: "What a hiring manager sees" });
  assert.match(await hiring.textContent(), /Resume link.*No resume link/s);
  assert.equal(await p.getByRole("region", { name: "How it looks and reads" }).getByRole("listitem").count(), AI_CRITERIA.length);
  // One portfolio doing it better and four similar ones, as names with links.
  assert.equal(await p.getByRole("region", { name: "Portfolios to learn from" }).getByRole("link").count(), 5);

  // Share is the primary action; the PDF is the browser's own print.
  await p.getByRole("button", { name: "Share" }).waitFor();
  await p.getByRole("button", { name: "PDF" }).waitFor();
  // Not on the list: the request goes to the community list's form.
  assert.match(await p.getByRole("link", { name: /Add me to the leaderboard/ }).getAttribute("href"), /submit-portfolio\.yml&url=/);
  // The owner's own panel.
  await p.getByRole("region", { name: "Your report" }).getByRole("button", { name: "Delete" }).waitFor();

  // The print view: the report alone, no shell, no buttons.
  await p.emulateMedia({ media: "print" });
  assert.equal(await p.getByRole("banner").isVisible(), false);
  assert.equal(await p.getByRole("button", { name: "Share" }).isVisible(), false);
  assert.equal(await p.getByRole("region", { name: "Your report" }).isVisible(), false);
  assert.ok(await p.getByText(/Gemini's scores \(gemini-3\.5-flash-lite\) are an opinion/).isVisible());
  await p.emulateMedia({ media: "screen" });

  // The share image says the grade, for the report's link only.
  const og = await p.request.get(`${BASE}/grade/${id}/opengraph-image`);
  assert.equal(og.status(), 200);
  assert.equal(og.headers()["content-type"], "image/png");
  assert.match(og.headers()["cache-control"], /^private/);

  assert.deepEqual(errors, []);
  await context.close();
});

test("Cloudflare's checkbox: the grade waits for the tick, says so, then sends its token", { skip: !grading }, async () => {
  const { page: p, context, errors } = await freshPage(1280);
  // A stand-in for Turnstile that asks for a tick (before-interactive-callback)
  // and gives its token only when the test ticks; Turnstile.tsx uses an
  // existing window.turnstile instead of loading Cloudflare's script.
  await p.addInitScript(() => {
    window.turnstile = {
      render(el, opts) {
        el.textContent = "Verify you are human";
        setTimeout(() => opts["before-interactive-callback"]?.(), 50);
        window.__tick = () => opts.callback("ticked-token");
        return "w1";
      },
      reset() {},
      remove() {},
    };
  });
  const posts = [];
  await p.route("**/api/grade", (route) => {
    posts.push(route.request().postDataJSON());
    return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "bad_request", message: "Stopped by the test." }) });
  });
  await p.goto(BASE + "/grade");
  const form = p.locator("#grade form");
  await form.getByLabel("Your portfolio address").fill(`tick-${RUN}.example.dev`);
  await form.getByRole("button", { name: "Grade it" }).click();
  await form.getByText(/tick the box and your grade starts/).waitFor();
  // Past the few seconds an invisible check gets, nothing was sent without a token.
  await p.waitForTimeout(6000);
  assert.equal(posts.length, 0);
  await p.evaluate(() => window.__tick());
  await form.getByText("Stopped by the test.").waitFor();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].turnstileToken, "ticked-token");
  assert.equal(await form.getByText(/tick the box/).count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("no capture service (staging): the free checks are the answer, said plainly, not a failure", { skip: !grading }, async () => {
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    const { page: p, context, errors } = await freshPage(width, height);
    const id = await startGrade(p, `grade-off-${RUN}-${width}.dev`);
    // What POST /api/grade stores without GITHUB_DISPATCH_TOKEN (lib/grader/dispatch.mjs).
    await db.execute({ sql: "UPDATE grade_jobs SET status = 'unavailable', reason = ? WHERE id = ?", args: [NO_TOKEN_REASON, id] });
    await p.reload();
    await p.getByRole("heading", { level: 1, name: "Grade UI Tester" }).waitFor();
    assert.equal(await p.getByText(/couldn.t grade/i).count(), 0, "not called a failure");
    await p.getByRole("status").filter({ hasText: "the capture service isn't connected" }).waitFor();
    const steps = p.getByRole("list", { name: "What ran" });
    assert.match(await steps.textContent(), /Measuring: resume, GitHub, links, domain: done.*taking screenshots: not available.*Gemini .*: not available/s);
    const hiring = p.getByRole("region", { name: "What a hiring manager sees" });
    assert.match(await hiring.textContent(), /Can they see your work\?/);
    assert.match(await hiring.textContent(), /Resume: .*Fix: Link a PDF/s);
    await p.getByRole("link", { name: "Grade another portfolio" }).waitFor();
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(overflow, 0, `no sideways scroll at ${width}px`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test("nothing to fix: the calm empty state, and a stranger sees no owner tools", { skip: !grading }, async () => {
  const owner = await freshPage(390, 844);
  const id = await startGrade(owner.page, `perfect-ui-${RUN}.dev`);
  await finish(id, { perfect: true });
  await owner.context.close();

  const { page: p, context, errors } = await freshPage(390, 844);
  await p.goto(`${BASE}/grade/${id}`);
  const empty = p.getByRole("region", { name: "Nothing urgent to fix" });
  await empty.waitFor();
  assert.match(await empty.textContent(), /Every check passes and every score is high/);
  assert.equal(await p.getByRole("region", { name: "Your report" }).count(), 0);
  // A shared link is not celebrated: that is for the owner.
  await p.waitForTimeout(800);
  assert.equal(await p.locator("canvas[data-celebration]").count(), 0);
  assert.equal(await p.getByRole("status").filter({ hasText: "SSS tier!" }).count(), 0);
  // No sideways scroll on a phone.
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.deepEqual(errors, []);
  await context.close();
});

test("the report by email: a one-time link makes another browser the owner, once", { skip: !grading }, async () => {
  assert.ok(reportId, "the first test made a report");
  const reader = await freshPage(1440);
  await reader.page.goto(`${BASE}/grade/${reportId}`);
  await reader.page.getByRole("button", { name: "Email it to me" }).click();
  await reader.page.getByLabel("Your email").fill("reader@example.com");
  await reader.page.getByRole("button", { name: "Email me the link" }).click();
  await reader.page.getByText(/Check your inbox for the link/).waitFor();
  await reader.context.close();
  const mail = (await db.execute("SELECT text FROM email_outbox WHERE kind = 'grade-report' AND to_addr = 'reader@example.com' ORDER BY id DESC LIMIT 1")).rows[0];
  const link = String(mail.text).match(/(\/api\/grade\/link\?t=\S+)/)[1];

  const other = await freshPage(1440);
  await other.page.goto(BASE + link);
  await other.page.waitForURL(new RegExp(`/grade/${reportId}$`));
  await other.page.getByRole("region", { name: "Your report" }).waitFor();
  await other.context.close();

  const late = await freshPage(1440);
  await late.page.goto(BASE + link);
  await late.page.getByText(/That email link was already used/).waitFor();
  assert.equal(await late.page.getByRole("region", { name: "Your report" }).count(), 0);
  await late.context.close();
});

test("the owner deletes the report: it's gone for everyone", { skip: !grading }, async () => {
  const { page: p, context } = await freshPage(1440);
  const id = await startGrade(p, `delete-ui-${RUN}.dev`);
  await finish(id);
  await p.reload();
  const panel = p.getByRole("region", { name: "Your report" });
  await panel.getByRole("button", { name: "Delete", exact: true }).click();
  await panel.getByRole("button", { name: "Delete the report" }).click();
  await p.waitForURL(/\/grade\?deleted=1$/);
  await p.getByText(/The report and its screenshots are deleted/).waitFor();
  assert.equal((await p.request.get(`${BASE}/grade/${id}`)).status(), 404);
  await context.close();
});

test("a listed site's report offers the claim; the verified owner hides the grade", { skip: !grading || !games }, async () => {
  const { page: p, context, errors } = await freshPage(1440);
  const id = await startGrade(p, LISTED);
  await finish(id);
  await p.reload();
  await p.getByText("On the leaderboard", { exact: true }).waitFor();
  const claim = p.getByRole("link", { name: /Claim your portfolio/ });
  assert.equal(await claim.getAttribute("href"), `/claim?url=${encodeURIComponent(LISTED)}`);
  await context.close();

  // A GitHub account, verified by the site owner's review (as tests/games-api.test.mjs does).
  const gh = 800000000 + Math.floor(Math.random() * 1e6);
  const token = (login) => sessionToken(login === "e2e-admin" ? { id: ADMIN_ID, login } : { id: gh, login });
  const call = (cookie, path, body) =>
    fetch(BASE + path, { method: body ? "POST" : "GET", headers: { cookie: `authjs.session-token=${cookie}`, origin: BASE, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  const mine = await token("claim-ui");
  assert.equal((await call(mine, "/api/owner/claims", { url: LISTED, method: "manual" })).claim.status, "review");
  const admin = await token("e2e-admin");
  const queued = (await call(admin, "/api/admin/claims")).claims.find((c) => c.url === LISTED && c.owner === `gh:${gh}`);
  assert.equal((await call(admin, "/api/admin/claims", { id: queued.id, decision: "verified" })).claim.status, "verified");

  const owner = await freshPage(1440);
  await owner.context.addCookies([{ name: "authjs.session-token", value: mine, url: BASE }]);
  await owner.page.goto(`${BASE}/claim?url=${encodeURIComponent(LISTED)}`);
  const domain = new URL(LISTED).hostname.replace(/^www\./, "");
  await owner.page.getByRole("heading", { level: 1, name: `Manage ${domain}` }).waitFor();
  const hide = owner.page.getByRole("switch", { name: "Hide the grade" });
  assert.equal(await hide.getAttribute("aria-checked"), "false");
  await hide.click();
  await owner.page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "true");
  assert.equal((await call(mine, "/api/owner/claims")).claims.find((c) => c.url === LISTED).state.hideGrade, true);
  // Removal asks for the domain first.
  await owner.page.getByRole("button", { name: "Remove", exact: true }).click();
  const confirm = owner.page.getByRole("button", { name: "Remove my portfolio" });
  assert.ok(await confirm.isDisabled());
  await owner.page.getByLabel(/to confirm/).fill(domain);
  assert.ok(await confirm.isEnabled());
  await owner.page.getByRole("button", { name: "Keep it" }).click();
  // Put it back as it was.
  await owner.page.getByRole("switch", { name: "Hide the grade" }).click();
  await owner.page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "false");
  assert.deepEqual([...errors, ...owner.errors], []);
  await owner.context.close();
});

test("how grading works: tiers by ELO, the fine print, how to improve, the bands, what's checked, how face-offs make a tier; in the sitemap", async () => {
  for (const width of [1440, 390]) {
    const { page: p, context, errors } = await freshPage(width);
    await p.goto(`${BASE}/grading`);
    await p.getByRole("heading", { level: 1, name: "How grading works" }).waitFor();
    for (const t of ["SSS", "S plus", "S minus", "A plus", "A minus", "B minus", "C plus", "D"]) await p.getByRole("img", { name: `Tier ${t}`, exact: true }).first().waitFor();
    for (const name of ["Your tier is your place by ELO", "A careful ELO, updates and the grade", "How to improve your tier", "Facts by code, quality by AI", "How face-offs make a tier"]) await p.getByRole("heading", { name }).waitFor();
    await p.getByRole("heading", { name: "Points from automated checks" }).waitFor();
    await p.getByText(/Every graded portfolio gets a starting rank from automated checks/).waitFor();
    assert.equal(await p.getByRole("region", { name: "Facts by code, quality by AI" }).getByRole("listitem").count(), 12);
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(errors, []);
    await context.close();
  }
  // The site's own pages are in the sitemap's pages part (lib/sitemap-entries.ts).
  const sitemap = await (await fetch(`${BASE}/sitemap/pages.xml`)).text();
  assert.match(sitemap, /\/grading<\/loc>/);
  assert.doesNotMatch(sitemap, /\/grade\/[A-Za-z0-9_-]{22}/);
});

test("claim: always reachable, finds a listed site by its address", async () => {
  const { page: p, context, errors } = await freshPage(390, 844);
  await p.goto(`${BASE}/claim`);
  await p.getByRole("heading", { level: 1, name: "Remove or manage your portfolio" }).waitFor();
  const host = new URL(LISTED).hostname.replace(/^www\./, "");
  await p.getByLabel("Your portfolio address").fill(host);
  await p.getByRole("button", { name: "Find it" }).click();
  await p.getByRole("heading", { level: 1, name: new RegExp(`Claim ${host.replace(/\./g, "\\.")}`) }).waitFor();
  await p.goto(`${BASE}/claim?url=no-such-portfolio.example`);
  await p.getByText("That address isn't on the list.").waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});
