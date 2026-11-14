// The letter shown with tiers by ELO (lib/tiers-letters.mjs, RANKING_V2 on):
// a listed site's own tier by ELO, a visitor's starting rank from its points,
// no letter for "not a portfolio", only public letters for the portfolios a
// report points to, and the report email naming the tier by ELO. With the
// flag off (eloTiers false) the email keeps Gemini's letter, as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { ensureTierSchema, readSiteRow, readTierMeta, standingOf } from "../lib/tiers-db.mjs";
import { refreshTiers } from "../lib/tiers-store.mjs";
import { publicLetters, reportTier, withEloLetters } from "../lib/tiers-letters.mjs";
import { requestEmail, reportEmail, sendDueEmails } from "../lib/grader/notify.mjs";
import { createJob } from "../lib/grader/jobs.mjs";
import { isPublicTier } from "../lib/tiers.mjs";

const grade = (axis, letter = "B", extra = {}) => ({
  is_portfolio: true,
  tier: letter,
  quality_score: axis,
  checks_score: 80,
  rubric_version: 2,
  model: "gemini-3.5-flash-lite",
  judged_at: "2026-11-12T00:00:00.000Z",
  ...Object.fromEntries(["visual_design", "five_second_test", "storytelling", "writing", "memorability"].map((k) => [k, { score: axis, note: "" }])),
  ...extra,
});
const url = (i) => `https://site${i}.example/`;

async function library() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiers-letters-"));
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(db);
  await ensureTierSchema(db);
  await db.batch(
    Array.from({ length: 150 }, (_, i) => ({ sql: "INSERT INTO portfolios (url, status, ai_rubric) VALUES (?, 'live', ?)", args: [url(i), JSON.stringify(grade(1 + (i % 5), "B"))] })),
    "write"
  );
  await refreshTiers(db, { now: Date.parse("2026-11-13T00:00:00Z") });
  return db;
}

test("a report's letter by ELO: a listed site's own tier, a visitor's starting rank, none for 'not a portfolio'", async () => {
  const db = await library();
  const meta = await readTierMeta(db);
  // A listed site: exactly its standing's tier, whatever Gemini said.
  const own = standingOf(await readSiteRow(db, url(4)), meta).tier;
  assert.equal(await reportTier(db, { url: url(4), result: grade(1, "S") }), own);
  // A visitor's site: a tier from the points its grade shows.
  const visitor = await reportTier(db, { url: "https://visitor.example/", result: grade(5, "D") });
  assert.ok(typeof visitor === "string" && visitor.length > 0);
  // No letter where Gemini's would mislead.
  assert.equal(await reportTier(db, { url: url(4), result: grade(5, "S", { is_portfolio: false }) }), null);
  assert.equal(await reportTier(db, { url: url(4), result: { error: "no_usable_captures" } }), null);
  assert.equal(await reportTier(db, { url: url(4), result: null }), null);
});

test("the portfolios a report points to show their public tier by ELO only", async () => {
  const db = await library();
  const letters = await publicLetters(db, [url(0), url(1), url(2), url(3), url(4), "https://not-listed.example/"]);
  for (const [u, t] of letters) assert.ok(t === null || isPublicTier(t), `${u}: ${t}`);
  assert.equal(letters.get("https://not-listed.example/"), null);
  // A lower tier (C or D) shows no letter: at least one of 150 is below B-.
  const all = await publicLetters(db, Array.from({ length: 150 }, (_, i) => url(i)));
  assert.ok([...all.values()].some((t) => t === null));
});

test("a public job gets its letters by ELO, marked, and nothing else changes", async () => {
  const db = await library();
  const job = {
    url: url(7),
    report: { tier: "S", isPortfolio: true, percentile: { topPct: 3 }, similar: [{ url: url(8), tier: "A" }], better: [{ criterion: "writing", sites: [{ url: url(9), tier: "S" }] }] },
  };
  const raw = { url: url(7), result: JSON.stringify(grade(2, "S")) };
  const out = await withEloLetters(db, job, raw);
  const meta = await readTierMeta(db);
  assert.equal(out.report.eloTiers, true);
  assert.equal(out.report.tier, standingOf(await readSiteRow(db, url(7)), meta).tier);
  assert.deepEqual(out.report.percentile, { topPct: 3 });
  const pub = await publicLetters(db, [url(8), url(9)]);
  assert.equal(out.report.similar[0].tier, pub.get(url(8)) ?? "");
  assert.equal(out.report.better[0].sites[0].tier, pub.get(url(9)) ?? "");
  // The input is left as it was.
  assert.equal(job.report.tier, "S");
});

test("the report email names the tier by rank with RANKING_V2, Gemini's letter without", async () => {
  // Gemini's plain letters read as before.
  assert.match(reportEmail({ url: url(1), link: "https://x/l", status: "done", tier: "A" }).text, /tier A\b/);
  assert.match(reportEmail({ url: url(1), link: "https://x/l", status: "done", tier: "A-" }).text, /tier A−/);
  for (const eloTiers of [false, true]) {
    const db = await library();
    const id = await createJob(db, { url: url(10), siteKey: "site10.example", status: "done", now: Date.parse("2026-11-13T00:00:00Z") });
    await db.execute({ sql: "UPDATE grade_jobs SET result = ? WHERE id = ?", args: [JSON.stringify(grade(1, "S")), id] });
    await requestEmail(db, { jobId: id, email: "jane@example.com", secret: "s", now: Date.parse("2026-11-13T00:00:00Z") });
    const sent = [];
    const gate = { send: async (m) => (sent.push(m), { sent: true }) };
    await sendDueEmails(db, { gate, secret: "s", base: "https://pr.test", now: Date.parse("2026-11-13T00:01:00Z"), eloTiers });
    assert.equal(sent.length, 1);
    // With RANKING_V2 the tier by rank the report carries is named, never Gemini's letter: this report has no rank.
    if (eloTiers) assert.ok(!/\btier [SABCD]/.test(sent[0].text), `${eloTiers}: ${sent[0].text.split("\n")[0]}`);
    else assert.ok(sent[0].text.includes("tier S"), `${eloTiers}: ${sent[0].text.split("\n")[0]}`);
  }
});
