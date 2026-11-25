// The redesigned profile at /p/<address>/next, end to end against the running
// production build (scripts/test-e2e.sh, which turns PROFILE_NEXT on): it
// renders a listed site's real report from its saved checks, says noindex in
// its metadata and its X-Robots-Tag header, is in no sitemap and linked from
// nowhere (the current profile is unchanged), and has its own share card. With
// the switch off, as in production, the page and its card answer 404: a
// second server is started on the same build with PROFILE_NEXT=false.
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
// One listed site no other test renders.
const SITE = feed[1300];
const nextPath = (url) => `/p/${encodeURIComponent(url)}/next`;

before(async () => {
  if (skip) return;
  const db = createClient({ url: DB_URL, timeout: 10000 });
  await migrate(db);
  const facts = {
    v: 4,
    final_url: SITE.url,
    own_domain: true,
    resume: false,
    github: true,
    contact: true,
    footer_year: 2026,
    builder: null,
    project_links: { checked: 4, ok: 3, broken: 1, blocked: 0 },
    measured_at: "2026-11-22T08:00:00Z",
  };
  await db.execute({
    sql: "INSERT INTO portfolios (url, status, facts) VALUES (?, 'live', ?) ON CONFLICT(url) DO UPDATE SET status = 'live', health = NULL, facts = excluded.facts",
    args: [SITE.url, JSON.stringify(facts)],
  });
  const inspect = { ok: true, finalUrl: SITE.url, https: true, customDomain: true, description: "A developer.", ogImage: null, ogImageLoads: false, githubUrl: "https://github.com/someone", hasResume: false, hasContact: true, copyrightYear: 2026, measuredAt: "2026-11-20T10:00:00Z" };
  const psi = { ok: true, scores: { performance: 71, accessibility: 92, seo: 100, "best-practices": 96 }, measuredAt: "2026-11-23T09:30:00Z" };
  for (const [k, v] of [[`inspect:${SITE.url}`, inspect], [`psi:${SITE.url}`, psi]]) {
    await db.execute({ sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, ?, ?)", args: [k, JSON.stringify(v), Date.now()] });
  }
});

test("with the switch on: the report from the saved checks, the actions, the claim card; noindex", { skip }, async () => {
  const res = await fetch(BASE + nextPath(SITE.url));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("x-robots-tag") ?? "", /noindex/);
  // React separates neighbouring text with <!-- --> markers; the text a visitor reads has none.
  const html = (await res.text()).replaceAll("<!-- -->", "");
  assert.match(html, /<meta name="robots" content="noindex, nofollow"\/>/);
  assert.ok(!html.includes("application/ld+json"), "no structured data");
  assert.ok(html.includes(`>${SITE.name}</h1>`), "the name");
  for (const text of ["The report", "Basics", "Projects", "Mobile", "3 of 4 project links load", "Run this test", "One Lighthouse run on 23 Nov 2026.", "What we recommend changing", "Copy as a prompt", "Is this your portfolio? Claim it or share it"]) {
    assert.ok(html.includes(text), `shows "${text}"`);
  }
  // Each finding is one recommendation: no resume, no share image, a link that does not load, speed 71.
  for (const r of ["Link your resume from the home page.", "Add a share image", "Fix or remove the project link that does not load.", "Speed up the page on mobile: Lighthouse gives it 71 of 100."]) {
    assert.ok(html.includes(r), `recommends "${r}"`);
  }
  assert.ok(html.includes(`href="https://pagespeed.web.dev/analysis?url=${encodeURIComponent(SITE.url)}&amp;form_factor=mobile"`), "the PageSpeed link");
  assert.ok(html.includes(`href="/claim?url=${encodeURIComponent(SITE.url)}"`), "the claim link");
  // No score and no points anywhere, no Gemini card, no "Other portfolios in this tier" (the page, not the site's shell).
  const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
  for (const gone of ["of 100 points", "Code checks score", "Gemini", "Other portfolios in this tier", "First five seconds", "Design", "Writing", "cookie"]) {
    assert.ok(!main.includes(gone), `does not show "${gone}"`);
  }
  // The share card it shows.
  const card = await fetch(`${BASE}${nextPath(SITE.url)}/card`);
  assert.equal(card.status, 200);
  assert.equal(card.headers.get("content-type"), "image/png");
  assert.ok((await card.arrayBuffer()).byteLength > 5000);
});

test("in no sitemap and linked from nowhere: the current profile is unchanged", { skip }, async () => {
  const current = await fetch(`${BASE}/p/${encodeURIComponent(SITE.url)}`);
  assert.equal(current.status, 200);
  assert.ok(!(await current.text()).includes("/next"), "the current profile does not link the new one");
  const index = await (await fetch(`${BASE}/sitemap.xml`)).text();
  const parts = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  for (const part of parts) {
    const xml = await (await fetch(BASE + part)).text();
    assert.ok(!/\/next<\/loc>/.test(xml), `${part} lists no /next page`);
  }
  // An address PortfolioRank does not know is a 404 here too.
  assert.equal((await fetch(BASE + nextPath("https://not-listed.example"))).status, 404);
});

// ---------------------------------------------------------------- switch off

const freePort = () =>
  new Promise((ok, no) => {
    const s = net.createServer();
    s.once("error", no);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

let off = null;
after(() => {
  if (off?.pid) {
    try {
      process.kill(-off.pid);
    } catch {
      off.kill();
    }
  }
});

test("with the switch off (production): the page and its card answer 404", { skip: skip || !fs.existsSync(path.join(process.cwd(), ".next", "BUILD_ID")) }, async () => {
  const port = await freePort();
  off = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
    env: { ...process.env, PROFILE_NEXT: "false", PORT: String(port) },
    stdio: "ignore",
    detached: true,
  });
  const base = `http://localhost:${port}`;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(`${base}/`).then(() => true, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(up, "the second server started");
  assert.equal((await fetch(base + nextPath(SITE.url))).status, 404);
  assert.equal((await fetch(`${base}${nextPath(SITE.url)}/card`)).status, 404);
  // The current profile is there either way.
  assert.equal((await fetch(`${base}/p/${encodeURIComponent(SITE.url)}`)).status, 200);
});
