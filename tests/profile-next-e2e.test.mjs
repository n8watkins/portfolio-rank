// The redesigned profile at /p/<address>/next, end to end against the running
// production build (scripts/test-e2e.sh, which turns PROFILE_NEXT and the
// other switches on): it renders a listed site's real report from its saved
// checks, stored exactly as production stores them (the cache value without a
// time, the time in the row's `at`), says noindex in its metadata and its
// X-Robots-Tag header, is in no sitemap and linked from nowhere (the current
// profile is unchanged), and has its card. Two more servers on the same build:
// production's switches (TOOLS_ENABLED, GAMES_V2 and RANKING_V2 off) with the
// page on, where it says only what is true there; and the page off, where it
// and its card answer 404.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createClient } from "@libsql/client";
import feed from "../data/feed.json" with { type: "json" };
import { migrate } from "../lib/schema.mjs";

const BASE = process.env.E2E_BASE_URL;
const DB_URL = process.env.E2E_DB_URL;
const on = process.env.PROFILE_NEXT === "true";
const skip = !BASE || !DB_URL || !on;
const built = fs.existsSync(path.join(process.cwd(), ".next", "BUILD_ID"));
// Listed sites no other test renders; each server renders its own (they share the build's page cache).
const SITE = feed[1300];
const OFF_SITE = feed[1301];
const PROD_SITE = feed[1302];
const ADDED = "https://profile-next-added.example";
const nextPath = (url) => `/p/${encodeURIComponent(url)}/next`;
// When the checks were saved: the row's `at`, as lib/cache.ts stores it.
const INSPECT_AT = Date.parse("2026-11-20T10:00:00Z");
const PSI_AT = Date.parse("2026-11-23T09:30:00Z");

async function seed(db, url) {
  const facts = {
    v: 4,
    final_url: url,
    own_domain: true,
    resume: false,
    github: true,
    contact: true,
    footer_year: 2026,
    builder: null,
    project_links: { checked: 4, ok: 1, broken: 2, blocked: 1 },
    measured_at: "2026-11-22T08:00:00Z",
  };
  await db.execute({
    sql: "INSERT INTO portfolios (url, status, facts) VALUES (?, 'live', ?) ON CONFLICT(url) DO UPDATE SET status = 'live', health = NULL, facts = excluded.facts",
    args: [url, JSON.stringify(facts)],
  });
  // The values as the polish check and Lighthouse save them: no time inside.
  const inspect = { ok: true, finalUrl: url, https: true, customDomain: true, description: "A developer.", ogImage: null, ogImageLoads: false, githubUrl: "https://github.com/someone", hasResume: false, hasContact: true, copyrightYear: 2026 };
  const psi = { ok: true, strategy: "mobile", scores: { performance: 71, accessibility: 92, seo: 100, "best-practices": 96 } };
  for (const [k, v, at] of [[`inspect:${url}`, inspect, INSPECT_AT], [`psi:${url}`, psi, PSI_AT]]) {
    await db.execute({ sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, ?, ?)", args: [k, JSON.stringify(v), at] });
  }
}

before(async () => {
  if (skip) return;
  const db = createClient({ url: DB_URL, timeout: 10000 });
  await migrate(db);
  await seed(db, SITE.url);
  await seed(db, PROD_SITE.url);
  // A site added through "Add your portfolio" (TOOLS_ENABLED, on in this run): known by its grade job, not listed.
  const now = new Date().toISOString();
  await db.execute({
    sql: "INSERT OR REPLACE INTO grade_jobs (id, url, site_key, status, created_at, updated_at) VALUES ('profileNextAdded000001', ?, ?, 'queued', ?, ?)",
    args: [ADDED, new URL(ADDED).hostname, now, now],
  });
});

test("a site added through the tools and not in the face-offs shows \"?\", as today's profile does", { skip }, async () => {
  const { res, html } = await page(BASE, ADDED);
  assert.equal(res.status, 200);
  const main = mainOf(html);
  assert.ok(main.includes("Not ranked yet"), "not ranked");
  assert.ok(main.includes("It joins the face-offs once it&#x27;s graded."));
  assert.ok(!main.includes("votes so far") && !main.includes(">ELO<"), "no ELO for a site not in the face-offs");
});

// React separates neighbouring text with <!-- --> markers; the text a visitor reads has none.
const page = async (base, url) => {
  const res = await fetch(base + nextPath(url));
  return { res, html: (await res.text()).replaceAll("<!-- -->", "") };
};
const mainOf = (html) => html.slice(html.indexOf("<main"), html.indexOf("</main>"));

test("with the switch on: the report from the saved checks, the actions, the claim card; noindex", { skip }, async () => {
  const { res, html } = await page(BASE, SITE.url);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("x-robots-tag") ?? "", /noindex/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow"\/>/);
  assert.ok(!html.includes("application/ld+json"), "no structured data");
  assert.ok(html.includes(`>${SITE.name}</h1>`), "the name");
  for (const text of [
    "The report",
    // The newest saved check shown, from the rows' `at`.
    "Checked on 23 Nov 2026. No AI.",
    "One Lighthouse run on 23 Nov 2026.",
    // The product's words (pipeline/facts.mjs projectLinksText): the link behind a bot check is out of the total.
    "1 of 3 project links load",
    "1 behind a bot check.",
    "Run this test",
    "What we recommend changing",
    "Copy as a prompt",
    "Is this your portfolio? Claim it or share it",
    // TOOLS_ENABLED is on in this run: the newer claim flow.
    "First prove it&#x27;s yours: put a short code we give you on your site. Then you can re-check it, hide its grade or remove it.",
    "press Verify.",
  ]) {
    assert.ok(html.includes(text), `shows "${text}"`);
  }
  for (const r of ["Link your resume from the home page.", "Add a share image", "Fix or remove the 2 project links that do not load.", "Speed up the page on mobile: Lighthouse gives it 71 of 100."]) {
    assert.ok(html.includes(r), `recommends "${r}"`);
  }
  assert.ok(html.includes(`href="https://pagespeed.web.dev/analysis?url=${encodeURIComponent(SITE.url)}&amp;form_factor=mobile"`), "the PageSpeed link");
  assert.ok(html.includes(`href="/claim?url=${encodeURIComponent(SITE.url)}"`), "the claim link");
  // No score, no points, no Gemini card, nothing unmeasured, and no promise about what a shared link shows.
  const main = mainOf(html);
  for (const gone of ["of 100 points", "Code checks score", "Gemini", "Other portfolios in this tier", "First five seconds", ">Design<", ">Writing<", "Mobile only", "Tracking cookies", ">Desktop<", "What people see when the link is posted", "this card goes with the link"]) {
    assert.ok(!main.includes(gone), `does not show "${gone}"`);
  }
  const card = await fetch(`${BASE}${nextPath(SITE.url)}/card`);
  assert.equal(card.status, 200);
  assert.equal(card.headers.get("content-type"), "image/png");
  assert.ok((await card.arrayBuffer()).byteLength > 5000);
});

test("in no sitemap and linked from nowhere: the current profile is unchanged", { skip }, async () => {
  const current = await fetch(`${BASE}/p/${encodeURIComponent(SITE.url)}`);
  assert.equal(current.status, 200);
  assert.ok(!(await current.text()).includes("/next"), "the current profile does not link the new one");
  // The sitemap's profiles are profilePath(url) (lib/sitemap-entries.ts), never the /next page. Read from the
  // source, not fetched: a fetch here would fill the sitemap's day-long cache before tests/sitemap-pages.test.mjs seeds it.
  const entries = fs.readFileSync(path.join(process.cwd(), "lib", "sitemap-entries.ts"), "utf8");
  assert.match(entries, /url: `\$\{BASE\}\$\{profilePath\(url\)\}`/);
  assert.ok(!entries.includes("/next"));
  assert.match(fs.readFileSync(path.join(process.cwd(), "lib", "profile.ts"), "utf8"), /export const profilePath = \(url: string\) => `\/p\/\$\{encodeURIComponent\(url\)\}`;/);
  // An address PortfolioRank does not know is a 404 here too.
  assert.equal((await fetch(BASE + nextPath("https://not-listed.example"))).status, 404);
});

// ---------------------------------------------------------------- more servers on the same build

const freePort = () =>
  new Promise((ok, no) => {
    const s = net.createServer();
    s.once("error", no);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

const servers = [];
after(() => {
  for (const s of servers) {
    try {
      process.kill(-s.pid);
    } catch {
      s.kill();
    }
  }
});

/** A `next start` on the same build and database with these switches; its base address once it answers. */
async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: "ignore",
    detached: true,
  });
  servers.push(child);
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${base}/`).then(() => true, () => false)) return base;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("the server did not start");
}

test("production's switches with the page on: the claim card offers the older flow, the tier card shows the ELO", { skip: skip || !built }, async () => {
  const base = await startServer({ PROFILE_NEXT: "true", TOOLS_ENABLED: "false", GAMES_V2: "false", RANKING_V2: "false", FULLPAGE_PREVIEW_ENABLED: "false", IMAGES_BASE_URL: "" });
  const { res, html } = await page(base, PROD_SITE.url);
  assert.equal(res.status, 200);
  const main = mainOf(html);
  for (const text of [
    // /claim's own introduction for the older flow: hiding and removing need the code.
    "First prove it&#x27;s yours: a link to your GitHub profile on the site, or a short code you add to the page. Then, with the code, you can hide its grade or remove it.",
    "To claim: sign in with GitHub, then prove it on the claim page.",
    // Today's profile in this configuration: the ELO printed as it prints it (no separator) and its votes, no letter.
    ">ELO<",
    ">1200<",
    "<b>0</b><span>votes so far</span>",
    "Every site starts at an ELO of 1200; it moves as people vote in face-offs.",
    "One Lighthouse run on 23 Nov 2026.",
  ]) {
    assert.ok(main.includes(text), `shows "${text}"`);
  }
  for (const gone of ["re-check", "small file", "GitHub Pages", "press Verify", "re-grade", "verified at once", "1,200", "Not placed in a tier", 'aria-label="Tier', ">Tier<", "Play the screenshots"]) {
    assert.ok(!main.includes(gone), `does not show "${gone}"`);
  }
});

test("with the switch off (production): the page and its card answer 404", { skip: skip || !built }, async () => {
  const base = await startServer({ PROFILE_NEXT: "false" });
  assert.equal((await fetch(base + nextPath(OFF_SITE.url))).status, 404);
  assert.equal((await fetch(`${base}${nextPath(OFF_SITE.url)}/card`)).status, 404);
  // The current profile is there either way.
  assert.equal((await fetch(`${base}/p/${encodeURIComponent(OFF_SITE.url)}`)).status, 200);
});
