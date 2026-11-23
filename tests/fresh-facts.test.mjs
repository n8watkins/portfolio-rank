// A stored grade's code items read from the newest measured facts
// (lib/fresh-facts.mjs): the automated checks score (lib/tiers-store.mjs), the
// report card's lines (lib/grader/report.mjs) and the list's numbers
// (lib/games/stats.mjs) all read portfolios.facts when it is at least the
// grade's measuring version, and the grade's own copy otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { factsVersionOf, freshFactsFor, freshGrade, withFreshFacts } from "../lib/fresh-facts.mjs";
import { factLines, printView, strengthsAndFixes } from "../lib/grader/report.mjs";
import { refreshTiers, pointsOf } from "../lib/tiers-store.mjs";
import { siteStats } from "../lib/games/stats.mjs";

const NOW = new Date("2026-11-22T12:00:00Z");

/** A grade made with facts of version `v` that found no resume, no GitHub and two of three project links loading. */
function grade({ v = 2, resume = false } = {}) {
  const facts = {
    v,
    resume,
    github: false,
    contact: true,
    own_domain: true,
    footer_year: 2026,
    project_links: { checked: 3, ok: 2, broken: 1, blocked: 0 },
    template: null,
    signals: { score: 5 },
  };
  const ax = { score: 4, note: "fine" };
  return {
    is_portfolio: true,
    tier: "B",
    visual_design: ax,
    five_second_test: ax,
    storytelling: ax,
    writing: ax,
    memorability: ax,
    rubric_version: 2,
    quality_score: 4,
    checks: { resume, github: false, contact: true, project_links: false, own_domain: true, fresh_footer: true, original: true },
    checks_score: 0,
    facts,
    model: "gemini-test",
    judged_at: "2026-11-15T00:00:00Z",
  };
}

/** The page as measured again later: a resume and GitHub found, every project link loading. */
const measured = (v = 2) => ({
  v,
  resume: true,
  github: true,
  contact: true,
  own_domain: true,
  footer_year: 2026,
  project_links: { checked: 4, ok: 4, broken: 0, blocked: 0 },
  signals: { score: 6 },
  measured_at: "2026-11-22T00:00:00Z",
});

test("a graded site whose newest facts say resume yes, and whose grade says no, is read with a resume", () => {
  const g = grade();
  const read = withFreshFacts(g, JSON.stringify(measured()), { now: NOW });
  assert.equal(read.checks.resume, true);
  assert.equal(read.checks.github, true);
  assert.equal(read.checks.project_links, true);
  assert.equal(read.facts.resume, true);
  assert.deepEqual(read.facts.project_links, { checked: 4, ok: 4, broken: 0, blocked: 0 });
  assert.equal(read.facts_from, "measured");
  assert.equal(read.checks_score, 100);
  // Gemini's answer and the stored grade are untouched.
  for (const k of ["tier", "is_portfolio", "visual_design", "quality_score", "model", "judged_at"]) assert.deepEqual(read[k], g[k], k);
  assert.equal(g.checks.resume, false, "the stored grade object is not changed");
  // Only the code items come from the newest facts: the signals the removal rule reads stay the grade's.
  assert.deepEqual(read.facts.signals, { score: 5 });
  // The report card's lines and its fixes agree with it.
  const lines = Object.fromEntries(factLines(read).map((l) => [l.id, l]));
  assert.equal(lines.resume.pass, true);
  assert.equal(lines.resume.detail, "Resume or CV link found");
  // "4 of 4 load" for these version 2 facts; facts of version 3 read "4 of 4 project links load" (#278).
  assert.match(lines.project_links.detail, /^4 of 4 (?:project links )?load$/);
  assert.ok(!strengthsAndFixes(read).fixes.some((f) => f.criterion === "resume"));
  assert.ok(strengthsAndFixes(g).fixes.some((f) => f.criterion === "resume"), "the grade's own copy would ask for a resume");
  assert.equal(printView(read).facts.find((f) => f.id === "resume").pass, true);
  // And the automated checks score gives the resume its points.
  const pts = pointsOf(g, { facts: measured() }, null, NOW);
  assert.equal(pts.items.find((i) => i.id === "resume").points, 5);
  assert.equal(pts.items.find((i) => i.id === "github").points, 5);
  assert.equal(pts.items.find((i) => i.id === "projects").points, 15);
  assert.equal(pointsOf(g, {}, null, NOW).items.find((i) => i.id === "resume").points, 0);
});

test("without newest facts the grade's own copy is read", () => {
  const g = grade();
  assert.equal(withFreshFacts(g, null, { now: NOW }), g);
  assert.equal(withFreshFacts(g, "", { now: NOW }), g);
  assert.equal(withFreshFacts(g, "not json", { now: NOW }), g);
  assert.equal(freshGrade(JSON.stringify(g), null, { now: NOW }).checks.resume, false);
  // No grade, or an error or an empty object, is passed through as it is.
  assert.equal(withFreshFacts(null, measured()), null);
  assert.deepEqual(withFreshFacts({ error: "no_usable_captures" }, measured()), { error: "no_usable_captures" });
  assert.deepEqual(withFreshFacts({}, measured()), {});
  assert.equal(freshGrade("not json", measured()), null);
});

test("newest facts from an older measuring version than the grade's are ignored", () => {
  const g = grade({ v: 2 });
  assert.equal(withFreshFacts(g, measured(1), { now: NOW }), g);
  assert.equal(freshFactsFor(g, measured(1)), null);
  assert.ok(freshFactsFor(g, measured(2)), "the same version counts");
  assert.ok(freshFactsFor(g, measured(3)));
  // A grade from before versions (no `v`) takes any measured facts.
  const old = grade();
  delete old.facts.v;
  assert.equal(factsVersionOf(old.facts), 0);
  assert.equal(withFreshFacts(old, measured(1), { now: NOW }).checks.resume, true);
  // A project-link check the newest facts don't have yet keeps the grade's.
  const noLinks = { ...measured(), project_links: null };
  assert.deepEqual(withFreshFacts(g, noLinks, { now: NOW }).facts.project_links, g.facts.project_links);
  // A footer year the newest facts no longer find is unknown, not the grade's old answer.
  assert.equal(withFreshFacts(g, { ...measured(), footer_year: null }, { now: NOW }).checks.fresh_footer, null);
});

async function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-facts-"));
  const client = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(client);
  return client;
}

test("the full rebuild scores the newest facts, falls back to the grade's, and ignores an older version", async () => {
  const db = await tmpDb();
  const rows = [
    ["https://fresh.example/", grade(), measured(2)],
    ["https://none.example/", grade(), null],
    ["https://older.example/", grade(), measured(1)],
  ];
  await db.batch(
    rows.map(([url, g, f]) => ({ sql: "INSERT INTO portfolios (url, status, ai_rubric, facts) VALUES (?, 'live', ?, ?)", args: [url, JSON.stringify(g), f ? JSON.stringify(f) : null] })),
    "write"
  );
  await refreshTiers(db, { now: NOW.getTime() });
  const check = async (url) => {
    const g = JSON.parse(String((await db.execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [url] })).rows[0].ai_rubric));
    assert.equal(g.checks.resume, false, `${url}: the stored grade keeps its own checks`);
    return Object.fromEntries(g.rank.check.map(([id, points, measuredFlag]) => [id, { points, measured: measuredFlag }]));
  };
  const fresh = await check("https://fresh.example/");
  assert.deepEqual(fresh.resume, { points: 5, measured: 1 });
  assert.deepEqual(fresh.github, { points: 5, measured: 1 });
  assert.deepEqual(fresh.projects, { points: 15, measured: 1 });
  const none = await check("https://none.example/");
  assert.deepEqual(none.resume, { points: 0, measured: 1 });
  assert.deepEqual(none.projects, { points: 10, measured: 1 });
  const older = await check("https://older.example/");
  assert.deepEqual(older.resume, { points: 0, measured: 1 });

  // The list's numbers read the same facts: no grade's own copy has a resume, the newest facts of one do.
  const stats = await siteStats(db, { feed: rows.map(([url]) => ({ url, name: url })), now: NOW });
  assert.equal(stats.resumePct, 33);
});
