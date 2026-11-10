// The portfolio-likeness first pass (pipeline/signals.mjs) and how the health
// check stores it. Deterministic; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { NEEDS_REVIEW_MAX, portfolioSignals } from "../pipeline/signals.mjs";
import { runHealthCheck } from "../pipeline/health.mjs";
import { ensureRosterSchema } from "../pipeline/roster.mjs";

const PORTFOLIO = `<!doctype html><html><head><title>Jane Doe | Frontend Engineer</title></head><body>
<nav><a href="#about">About</a><a href="#projects">Projects</a><a href="/Jane_Doe_CV.pdf">Résumé</a></nav>
<h1>Hi, I'm Jane</h1>
<section id="projects"><h2>Selected work</h2><p>A design system used by 40 teams.</p></section>
<footer><a href="mailto:jane@example.com">Email</a> <a href="https://github.com/janedoe">GitHub</a>
<a href="https://www.linkedin.com/in/janedoe">LinkedIn</a></footer></body></html>`;

const STARTER = `<!doctype html><html><head><title>Create Next App</title></head><body>
<main><p>Get started by editing app/page.tsx. Save and see your changes instantly.</p>
<a href="https://vercel.com/templates">Templates</a></main></body></html>`;

test("a real portfolio scores every signal", () => {
  const s = portfolioSignals(PORTFOLIO, "Jane Doe");
  assert.deepEqual(s, {
    projects: true,
    about: true,
    contact: true,
    resume: true,
    github: true,
    name: true,
    score: 6,
    needsReview: false,
  });
});

test("a starter template with no portfolio signals needs review", () => {
  const s = portfolioSignals(STARTER, "Sam Lee");
  assert.equal(s.score, 0);
  assert.equal(s.needsReview, true);
});

test(`at most ${NEEDS_REVIEW_MAX} signal needs review; two do not`, () => {
  const one = portfolioSignals(`<title>Sam Lee</title><p>Coming soon.</p>`, "Sam Lee");
  assert.deepEqual([one.name, one.score, one.needsReview], [true, 1, true]);
  const two = portfolioSignals(`<title>Sam Lee</title><a href="mailto:s@x.dev">Say hi</a>`, "Sam Lee");
  assert.deepEqual([two.score, two.needsReview], [2, false]);
});

test("names match without accents; github needs a profile link, not just the word", () => {
  const s = portfolioSignals(`<h1>José Núñez</h1><p>I love GitHub.</p>`, "Jose Nunez");
  assert.equal(s.name, true);
  assert.equal(s.github, false);
  assert.equal(portfolioSignals(`<a href="https://github.com/jnunez">code</a>`, "x").github, true);
});

test("signals ignore scripts and styles", () => {
  const s = portfolioSignals(`<script>const projects = "about contact resume";</script><style>.about{}</style><p>Hello</p>`, "Kim");
  assert.equal(s.score, 0);
});

test("a single-page app is judged on its rendered page before it is flagged", async () => {
  const { checkSite } = await import("../pipeline/health.mjs");
  const shell = `<title>Portfolio</title><div id="root"><p>Loading the site, one moment please...</p></div>`;
  const r = await checkSite(
    { name: "Jane Doe", url: "https://jane.dev" },
    {
      fetchImpl: async (url) => ({ status: 200, ok: true, url, text: async () => shell }),
      render: async () => ({ status: 200, finalUrl: "https://jane.dev/", title: "Jane Doe", text: "Jane", html: PORTFOLIO }),
    }
  );
  assert.equal(r.ok, true);
  assert.equal(r.signals.score, 6);
  assert.equal(r.signals.needsReview, false);
});

test("a move to an unrelated domain is stored as a possible hijack for the monthly report", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signals-"));
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await ensureRosterSchema(db);
  const feed = [{ name: "Jane Doe", url: "https://jane.vercel.app" }];
  const fetchImpl = async () => ({ status: 200, ok: true, url: "https://casino.example/", text: async () => "<title>Best slots</title><p>" + "Win big today. ".repeat(10) + "</p>" });
  await runHealthCheck({ db, feed, fetchImpl, log: () => {} });
  const s = JSON.parse((await db.execute("SELECT signals FROM portfolios")).rows[0].signals);
  assert.deepEqual([s.hijack, s.moved_to], [true, "https://casino.example/"]);
});

test("the health check stores signals and needs_review, and keeps the last ones when a site fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signals-"));
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await ensureRosterSchema(db);
  const feed = [
    { name: "Jane Doe", url: "https://jane.dev" },
    { name: "Sam Lee", url: "https://sam.dev" },
  ];
  const pages = { "https://jane.dev": PORTFOLIO, "https://sam.dev": STARTER };
  const fetchImpl = async (url) => ({ status: 200, ok: true, url, text: async () => pages[url] });
  const s = await runHealthCheck({ db, feed, fetchImpl, log: () => {} });
  assert.deepEqual(s.needsReview, [{ url: "https://sam.dev", score: 0 }]);
  const rows = Object.fromEntries(
    (await db.execute("SELECT url, signals, needs_review FROM portfolios")).rows.map((r) => [r.url, r])
  );
  assert.equal(rows["https://sam.dev"].needs_review, 1);
  assert.equal(rows["https://jane.dev"].needs_review, 0);
  assert.equal(JSON.parse(rows["https://jane.dev"].signals).score, 6);

  // Next week Sam's site is down: the stored signals and the flag stay.
  const down = async (url) => ({ status: url.includes("sam") ? 404 : 200, ok: !url.includes("sam"), url, text: async () => pages[url] });
  await runHealthCheck({ db, feed, fetchImpl: down, log: () => {} });
  const sam = (await db.execute("SELECT signals, needs_review FROM portfolios WHERE url = 'https://sam.dev'")).rows[0];
  assert.equal(sam.needs_review, 1);
  assert.equal(JSON.parse(sam.signals).score, 0);
});
