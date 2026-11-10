// Model watch (pipeline/model-watch.mjs), offline: Google's answers recorded
// on 2026-11-10 (tests/fixtures/model-watch: models.list, the deprecations
// page and the release notes, as Google serves them), a throwaway database
// and the owner alerts (pipeline/alerts.mjs). The "next week" answers are
// the recorded ones with a few edits, made below.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { activeAlerts, reconcileAlerts } from "../pipeline/alerts.mjs";
import {
  CHANGELOG_URL,
  DEPRECATIONS_URL,
  MODELS_URL,
  buildReport,
  isModelWatchAlert,
  modelWatchSummary,
  parseChangelog,
  parseDeprecations,
  parseModels,
  readSources,
  reportText,
  runModelWatch,
} from "../pipeline/model-watch.mjs";

const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "model-watch");
const MODELS = JSON.parse(fs.readFileSync(path.join(FIX, "models-2026-11-10.json"), "utf8"));
const DEPRECATIONS = fs.readFileSync(path.join(FIX, "deprecations-2026-11-10.md"), "utf8");
const CHANGELOG = fs.readFileSync(path.join(FIX, "changelog-2026-11-10.md"), "utf8");
const KEY = "test-key-not-real";
const WEEK1 = new Date("2026-11-10T16:00:00Z");
const WEEK2 = new Date("2026-11-16T16:00:00Z");

function tempDb() {
  return createClient({ url: `file:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), "model-watch-")), "db.sqlite")}` });
}

/** Next week's answers: a new Flash-Lite, a shutdown date for 3.5, one model gone, a new release note. */
function nextWeek() {
  const models = structuredClone(MODELS);
  models.models = models.models.filter((m) => m.name !== "models/gemini-2.5-flash-lite");
  models.models.push({ ...models.models.find((m) => m.name === "models/gemini-3.5-flash-lite"), name: "models/gemini-3.9-flash-lite", displayName: "Gemini 3.9 Flash Lite", version: "3.9-flash-lite-11-2026" });
  const row35 = "  * `gemini-3.5-flash-lite`\n  * July 21, 2026\n  * No shutdown date announced\n  * ";
  assert.ok(DEPRECATIONS.includes(row35), "the recorded deprecations page has 3.5's row");
  const deprecations = DEPRECATIONS.replace(
    row35,
    "  * `gemini-3.9-flash-lite`\n  * November 16, 2026\n  * No shutdown date announced\n  * \n\n  ---\n\n  * `gemini-3.5-flash-lite`\n  * July 21, 2026\n  * January 20, 2027\n  * `gemini-3.9-flash-lite`"
  );
  const changelog = CHANGELOG.replace(
    "## November 10, 2026",
    "## November 16, 2026  {% id=\"11-16-2026\" %}\n\n*   **Gemini 3.9 Flash-Lite generally available (GA)**: Released\n  [Gemini 3.9 Flash-Lite](/docs/models/gemini-3.9-flash-lite) (`gemini-3.9-flash-lite`).\n  `gemini-3.5-flash-lite` will shut down no earlier than January 20, 2027.\n\n## November 10, 2026"
  );
  return { models, deprecations, changelog };
}

function google({ models = MODELS, deprecations = DEPRECATIONS, changelog = CHANGELOG, fail = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    const u = new URL(String(url));
    const which = u.origin + u.pathname === MODELS_URL ? "models" : String(url) === DEPRECATIONS_URL ? "deprecations" : String(url) === CHANGELOG_URL ? "changelog" : null;
    if (!which) return new Response("not found", { status: 404 });
    if (fail[which]) return new Response("unavailable", { status: fail[which] });
    if (which === "models") return new Response(JSON.stringify(models), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(which === "deprecations" ? deprecations : changelog, { status: 200, headers: { "content-type": "text/markdown" } });
  };
  return { calls, fetchImpl };
}

function run(db, g, now, extra = {}) {
  return runModelWatch({
    db,
    apiKey: KEY,
    fetchImpl: g.fetchImpl,
    now,
    reconcile: (conditions) => reconcileAlerts(db, { conditions, scope: isModelWatchAlert, now, email: null, to: null }),
    ...extra,
  });
}

test("the recorded sources parse: 62 models, the deprecations table and the release notes", () => {
  const models = parseModels(MODELS);
  assert.equal(Object.keys(models).length, 62);
  assert.equal(models["gemini-3.5-flash-lite"].version, "3.5-flash-lite-07-2026");
  assert.equal(models["gemini-3.5-flash-lite"].methods, "batchGenerateContent,countTokens,createCachedContent,generateContent");

  const deps = parseDeprecations(DEPRECATIONS);
  assert.ok(Object.keys(deps).length >= 80);
  assert.deepEqual(deps["gemini-3.5-flash-lite"], { group: "Gemini 3 models", status: "current", release: "2026-07-21", shutdown: null, shutdownText: "No shutdown date announced", replacement: null });
  assert.equal(deps["gemini-3.1-flash-lite"].shutdown, "2027-05-07");
  assert.equal(deps["gemini-3.1-flash-lite"].replacement, "gemini-3.5-flash-lite");
  assert.equal(deps["gemini-3.1-flash-lite-preview"].status, "deprecated");
  assert.equal(deps["gemini-3.1-pro-preview"].status, "preview");
  // A multi-line replacement cell is one cell.
  assert.match(deps["gemini-omni-1.1-flash"].replacement, /^gemini-omni-1\.2-flash \(Effective December 3, 2026, the endpoint is automatically routing/);

  const notes = parseChangelog(CHANGELOG);
  assert.equal(notes[0].date, "2026-11-10");
  assert.deepEqual(notes[0].titles, ["Gemini 4 Carbon (gemini-4-carbon) generally available (GA)"]);
  const july21 = notes.find((s) => s.date === "2026-07-21");
  assert.ok(july21.models.includes("gemini-3.5-flash-lite"));
  assert.ok(july21.titles.includes("Deprecated parameters"));
});

test("the first run records a baseline: nothing reported as new, both models in use fine", async () => {
  const db = tempDb();
  const g = google();
  const r = await run(db, g, WEEK1);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.report.baseline, ["models", "deprecations", "changelog"]);
  assert.equal(r.report.changes, 0);
  assert.deepEqual(r.report.newModels, []);
  assert.deepEqual(
    r.report.inUse.map((u) => [u.model, u.listed, u.shutdown, u.warning]),
    [
      ["gemini-3.5-flash-lite", true, null, false],
      ["gemini-3.1-flash-lite", true, "2027-05-07", false],
    ]
  );
  assert.deepEqual(r.conditions.map((c) => c.key), ["model-watch:report"]);
  assert.match(r.conditions[0].title, /baseline/);
  // Recorded and visible (email is off: nothing marked sent).
  const [alert] = await activeAlerts(db);
  assert.equal(alert.key, "model-watch:report");
  assert.equal(alert.sends, 0);
  const summary = await modelWatchSummary(db);
  assert.equal(summary.runs.length, 1);
  assert.match(summary.latest.text, /no setting was changed/);
});

test("next week: new Flash-Lite, 3.5's shutdown date, a model gone and a new release note are reported", async () => {
  const db = tempDb();
  await run(db, google(), WEEK1);
  const r = await run(db, google(nextWeek()), WEEK2);
  const { report } = r;
  assert.equal(report.baseline.length, 0);
  assert.deepEqual(report.newModels, [{ id: "gemini-3.9-flash-lite", displayName: "Gemini 3.9 Flash Lite", source: "model list", release: "2026-11-16" }]);
  assert.deepEqual(
    report.retired.map((x) => [x.id, x.what, x.shutdown ?? null]),
    [
      ["gemini-2.5-flash-lite", "no longer in the model list", null],
      ["gemini-3.5-flash-lite", "shutdown date set: January 20, 2027", "2027-01-20"],
    ]
  );
  assert.equal(report.changelog.length, 1);
  assert.equal(report.changelog[0].date, "2026-11-16");
  assert.deepEqual(report.changelog[0].inUse, ["gemini-3.5-flash-lite"]);
  assert.equal(report.changelog[0].link, `${CHANGELOG_URL}#11-16-2026`);
  assert.ok(report.flashLite.some((l) => l.startsWith("New: gemini-3.9-flash-lite")));
  assert.ok(report.flashLite.some((l) => l.startsWith("gemini-3.5-flash-lite: shutdown date set")));
  const judge = report.inUse.find((u) => u.model === "gemini-3.5-flash-lite");
  assert.equal(judge.warning, true, "65 days to shutdown is inside the 90-day warning");
  assert.equal(judge.replacement, "gemini-3.9-flash-lite");
  assert.equal(judge.changedThisWeek, true);

  const keys = r.conditions.map((c) => c.key).sort();
  assert.deepEqual(keys, ["model-watch:in-use:gemini-3.5-flash-lite", "model-watch:report"]);
  const text = reportText(report);
  assert.match(text, /gemini-3\.5-flash-lite \(grades and ranking comparisons\): .*shutdown 2027-01-20 at the earliest.*ACTION: plan a move/);
  assert.match(text, /New models:\n- gemini-3\.9-flash-lite/);
  assert.doesNotMatch(text, /\u2014/, "no em dashes");
});

test("model watch never changes a setting and never calls a model: only models.list and two docs pages, key in the header", async () => {
  const db = tempDb();
  const g = google();
  await run(db, g, WEEK1);
  assert.equal(g.calls.length, 3);
  for (const c of g.calls) {
    assert.doesNotMatch(c.url, /:generateContent|:countTokens|:batch/);
    assert.doesNotMatch(c.url, /key=/, "the key never travels in the URL");
  }
  assert.equal(g.calls[0].headers["x-goog-api-key"], KEY);
  // Only its own table and owner_alerts exist afterwards.
  const tables = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows.map((r) => r.name);
  assert.deepEqual(tables, ["model_watch_runs", "owner_alerts"]);
});

test("a failed source keeps last week's copy: nothing reported as retired, a source alert instead", async () => {
  const db = tempDb();
  await run(db, google(), WEEK1);
  const r = await run(db, google({ fail: { models: 503 } }), WEEK2);
  assert.equal(r.status, "partial");
  assert.deepEqual(r.report.retired, []);
  assert.equal(r.report.inUse[0].listed, true, "last week's list stands in");
  assert.deepEqual(r.conditions.map((c) => c.key), ["model-watch:source:models"]);
  // The week after, with the source back, compares with the kept copy: no change.
  const back = await run(db, google(), new Date("2026-11-23T16:00:00Z"));
  assert.equal(back.report.changes, 0);
  assert.deepEqual((await activeAlerts(db)).map((a) => a.key), []);
});

test("a page that stops parsing, or a near-empty model list, is a failed source, never 'everything retired'", async () => {
  const s = await readSources({ apiKey: KEY, fetchImpl: google({ models: { models: MODELS.models.slice(0, 3) }, deprecations: "<html>new layout</html>", changelog: "# Release notes\n\nmoved" }).fetchImpl });
  assert.equal(s.models.ok, false);
  assert.match(s.models.error, /fewer than 10/);
  assert.equal(s.deprecations.ok, false);
  assert.equal(s.changelog.ok, false);
  const noKey = await readSources({ apiKey: "", fetchImpl: google().fetchImpl });
  assert.match(noKey.models.error, /GEMINI_API_KEY is not set/);
  const report = buildReport(s, null, { now: WEEK1 });
  assert.deepEqual(report.baseline, []);
  assert.equal(report.changes, 0);
});

test("alerts: the weekly report clears on a quiet week, the in-use warning holds, and the night never clears them", async () => {
  const db = tempDb();
  await run(db, google(), WEEK1);
  await run(db, google(nextWeek()), WEEK2);
  // The end-of-day run reconciles its own alerts with the model-watch keys out of scope (worker/night.ts).
  await reconcileAlerts(db, { conditions: [{ key: "parked", kind: "problem", title: "1 item parked" }], scope: (k) => !isModelWatchAlert(k), now: new Date("2026-11-17T07:00:00Z") });
  assert.deepEqual((await activeAlerts(db)).map((a) => a.key).sort(), ["model-watch:in-use:gemini-3.5-flash-lite", "model-watch:report", "parked"]);
  // A quiet week: the report clears, the warning holds, the night's alert is untouched.
  const quiet = await run(db, google(nextWeek()), new Date("2026-11-23T16:00:00Z"));
  assert.equal(quiet.report.changes, 0);
  assert.deepEqual((await activeAlerts(db)).map((a) => a.key).sort(), ["model-watch:in-use:gemini-3.5-flash-lite", "parked"]);
});

test("a dry run prints the report and stores nothing", async () => {
  const db = tempDb();
  const lines = [];
  const r = await run(db, google(), WEEK1, { dryRun: true, log: (l) => lines.push(l), reconcile: async () => assert.fail("no alerts on a dry run") });
  assert.equal(r.alerts, null);
  assert.match(lines.join("\n"), /Models in use:/);
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM model_watch_runs")).rows[0].n), 0);
});
