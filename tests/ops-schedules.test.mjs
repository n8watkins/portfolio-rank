// The scheduled jobs and their watchdogs (audit of 2026-11-16): the weekly cron
// fires on Monday, the free-limits snapshot fails when it measured nothing,
// the backup refuses an empty database, nothing takes a stale backup quietly,
// and the night's alert reconcile leaves the newsletter's alerts alone.
// The workflow files themselves cannot run here; their notify jobs and the
// fallback guard are checked as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { finishedWeek } from "../pipeline/goals.mjs";
import { isNewsletterAlert } from "../lib/newsletter/alerts.mjs";
import { backupFreshness } from "../scripts/check-backup-fresh.mjs";
import { MAX_BACKUP_AGE_HOURS, staleReason } from "../scripts/refresh-staging-db.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-schedules-"));

function run(script, args, env) {
  const r = spawnSync(process.execPath, [path.join(ROOT, script), ...args], { env: { PATH: "", ...env }, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// ---------------------------------------------------------------------------
// (a) Cloudflare counts weekdays 1 = Sunday to 7 = Saturday
// ---------------------------------------------------------------------------

const NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** The weekday field of a cron string as Cloudflare reads it: day names, or numbers from 1 = Sunday. */
function weekdays(cron) {
  const field = cron.trim().split(/\s+/)[4];
  if (field === "*") return "any";
  return field.split(",").map((part) => {
    const upper = part.toUpperCase();
    if (NAMES.includes(upper)) return NAMES.indexOf(upper);
    if (/^[1-7]$/.test(part)) return Number(part) - 1; // 1 = Sunday
    throw new Error(`weekday ${part} in "${cron}" is not a day name or 1-7`);
  });
}

const cronsOf = (text) => [...text.matchAll(/"crons":\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));

test("the weekly cron fires on Monday, in Cloudflare's weekday numbering", () => {
  assert.deepEqual(weekdays("0 16 * * 1"), [0], "the old string was a Sunday");
  assert.deepEqual(weekdays("0 16 * * MON"), [1]);
  const model = read("worker/model-watch.ts").match(/MODEL_WATCH_CRON = "([^"]+)"/)[1];
  assert.deepEqual(weekdays(model), [1], `MODEL_WATCH_CRON "${model}"`);
  // One string everywhere it is matched: the trigger, the model watch and the group table.
  const wrangler = cronsOf(read("wrangler.jsonc"));
  assert.ok(wrangler.includes(model), "wrangler.jsonc has the trigger");
  assert.match(read("worker/crons.ts"), new RegExp(`"${model.replaceAll("*", "\\*")}": "weekly"`));
  assert.match(read("worker/index.ts"), /cron === MODEL_WATCH_CRON/);
});

test("every trigger in wrangler.jsonc, production and staging, names its weekday or leaves it open", () => {
  const crons = cronsOf(read("wrangler.jsonc"));
  assert.ok(crons.length >= 7, `found ${crons.length} triggers`);
  for (const cron of crons) {
    assert.equal(cron.trim().split(/\s+/).length, 5, cron);
    const field = cron.trim().split(/\s+/)[4];
    assert.ok(field === "*" || /^[A-Za-z,]+$/.test(field), `"${cron}": write the weekday as a name (MON), not a number`);
    weekdays(cron);
  }
});

test("the weekly job labels the week that just ended, run on Monday 16:00 UTC or later that week", () => {
  // Monday 16:00 UTC: 08:00 PST (Nov) and 09:00 PDT (Jul). Both label the week before.
  assert.equal(finishedWeek(new Date("2026-11-16T16:00:00Z")).week, "2026-11-09");
  assert.equal(finishedWeek(new Date("2026-07-13T16:00:00Z")).week, "2026-07-06");
  // Late: Tuesday to Sunday of the same week still label the same finished week.
  for (const day of ["17", "18", "19", "20", "21"]) assert.equal(finishedWeek(new Date(`2026-11-${day}T16:00:00Z`)).week, "2026-11-09", day);
  // On the Sunday it used to fire, the label was the week that ended six days earlier.
  assert.equal(finishedWeek(new Date("2026-11-15T16:00:00Z")).week, "2026-11-02");
  // Monday just after Pacific midnight is already the new week, so the label moves on exactly then.
  assert.equal(finishedWeek(new Date("2026-11-16T07:59:00Z")).week, "2026-11-02");
  assert.equal(finishedWeek(new Date("2026-11-16T08:00:00Z")).week, "2026-11-09");
});

// ---------------------------------------------------------------------------
// (b) workflow notices, as text
// ---------------------------------------------------------------------------

test("each scheduled workflow files its failure issue from a job that runs when a job is cancelled or times out", () => {
  for (const [file, job] of [["sync-upstream", "sync"], ["health", "health"], ["upstream-removals", "removals"], ["backup", "backup"], ["limits", "snapshot"]]) {
    const text = read(`.github/workflows/${file}.yml`);
    assert.doesNotMatch(text, /name: Notify on failure/, `${file}: the step after the work never runs for a cancelled or timed-out job`);
    const notify = text.slice(text.indexOf("  notify-failure:"));
    assert.match(notify, /if: \$\{\{ always\(\) && /, file);
    assert.match(notify, new RegExp(`needs\\.${job}\\.result == 'failure' \\|\\| needs\\.${job}\\.result == 'cancelled'`), file);
  }
});

test("the fallback guard counts only a dispatched run that succeeded or is still going", () => {
  for (const file of ["sync-upstream", "health"]) {
    const text = read(`.github/workflows/${file}.yml`);
    assert.doesNotMatch(text, /--jq '\.total_count'/, file);
    assert.match(text, /select\(\.status != "completed" or \.conclusion == "success"\)/, file);
  }
});

// ---------------------------------------------------------------------------
// (c) backups: an empty snapshot fails, a missing night is noticed, an old backup is refused
// ---------------------------------------------------------------------------

test("a backup of an empty or wrong database fails instead of storing an empty snapshot", async () => {
  const empty = path.join(dir, "empty.db");
  createClient({ url: `file:${empty}` }).close();
  const r = run("scripts/backup-db.mjs", ["--out", path.join(dir, "empty.json.gz")], { TURSO_DATABASE_URL: `file:${empty}` });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /refusing to back up/);
  assert.equal(fs.existsSync(path.join(dir, "empty.json.gz")), false, "nothing is written");

  // Every table but no portfolios: also not a backup.
  const bare = path.join(dir, "bare.db");
  await migrate(createClient({ url: `file:${bare}` }));
  const bareRun = run("scripts/backup-db.mjs", ["--out", path.join(dir, "bare.json.gz")], { TURSO_DATABASE_URL: `file:${bare}` });
  assert.notEqual(bareRun.code, 0, bareRun.out);
  assert.match(bareRun.out, /0 portfolios/);

  // A few tables, even with a portfolio: the wrong database.
  const few = path.join(dir, "few.db");
  const fewDb = createClient({ url: `file:${few}` });
  await fewDb.batch(["CREATE TABLE portfolios (url TEXT)", "INSERT INTO portfolios VALUES ('https://a.dev')", "CREATE TABLE votes (id INTEGER)"]);
  const fewRun = run("scripts/backup-db.mjs", ["--out", path.join(dir, "few.json.gz")], { TURSO_DATABASE_URL: `file:${few}` });
  assert.notEqual(fewRun.code, 0, fewRun.out);
  assert.match(fewRun.out, /2 tables \(at least 30 expected\)/);

  // The real schema with one portfolio passes.
  await createClient({ url: `file:${bare}` }).execute("INSERT INTO portfolios (url, name, status) VALUES ('https://a.dev', 'A', 'live')");
  const good = run("scripts/backup-db.mjs", ["--out", path.join(dir, "ok.json.gz")], { TURSO_DATABASE_URL: `file:${bare}` });
  assert.equal(good.code, 0, good.out);
});

test("the freshness check fails when the newest backup is older than 30 hours or there is none", () => {
  const now = new Date("2026-11-16T13:30:00Z");
  const obj = (day, at) => ({ Key: `backups/portfoliorank-${day}.json.gz`, LastModified: new Date(at) });
  assert.equal(backupFreshness([obj("2026-11-16", "2026-11-16T05:00:20Z")], now).ok, true);
  const missed = backupFreshness([obj("2026-11-14", "2026-11-14T05:00:20Z"), obj("2026-11-15", "2026-11-15T05:00:20Z")], now);
  assert.equal(missed.ok, false);
  assert.match(missed.reason, /backups\/portfoliorank-2026-11-15\.json\.gz, is 32\.5 hours old/);
  assert.equal(backupFreshness([], now).ok, false);
  assert.equal(backupFreshness([{ Key: "backups/notes.txt", LastModified: now }], now).ok, false);
});

test("the staging refresh refuses a backup older than 48 hours unless told otherwise", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  assert.equal(MAX_BACKUP_AGE_HOURS, 48);
  assert.equal(staleReason("2026-11-16T05:00:00Z", now), null);
  assert.equal(staleReason("2026-11-14T13:00:00Z", now), null);
  assert.match(staleReason("2026-11-13T05:00:00Z", now), /79\.0 hours old \(limit 48\)/);
  assert.match(staleReason(undefined, now), /no usable export date/);
  assert.equal(staleReason("2026-11-13T05:00:00Z", now, 200), null);
  assert.match(read("scripts/refresh-staging-db.mjs"), /--allow-old/);
});

// ---------------------------------------------------------------------------
// (d) the free-limits snapshot
// ---------------------------------------------------------------------------

test("a limits snapshot that measured nothing fails, and says which sources were skipped", () => {
  const r = run("scripts/limits-snapshot.mjs", ["--dry-run"], { TURSO_PLATFORM_TOKEN: "", TURSO_ORG: "", CLOUDFLARE_API_TOKEN: "" });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /skipped: turso/);
  assert.match(r.out, /no measurement was taken/);
});

test("a skipped provider is a warning on the run, not a failure, when something else was measured", () => {
  const input = path.join(dir, "values.json");
  const summary = path.join(dir, "summary.md");
  fs.writeFileSync(input, JSON.stringify({ "r2.storage": { used: 1234 } }));
  const r = run("scripts/limits-snapshot.mjs", ["--dry-run", "--input", input], { GITHUB_STEP_SUMMARY: summary });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /::warning title=Free limits: provider skipped::turso/);
  assert.match(fs.readFileSync(summary, "utf8"), /### Free limits: skipped[\s\S]*- turso/);
});

// ---------------------------------------------------------------------------
// (e) the night's alert reconcile
// ---------------------------------------------------------------------------

test("the night's alert reconcile leaves the newsletter's stopped-issue alerts to the newsletter tick", () => {
  assert.equal(isNewsletterAlert("newsletter-stopped:12"), true);
  const scope = read("worker/night.ts").split("\n").find((l) => l.includes("scope: (key: string)"));
  assert.ok(scope, "the scope expression is there");
  for (const owner of ["isModelWatchAlert", "isRemovalAlert", "isEmailCapAlert", "isNightWatchAlert", "isNewsletterAlert"]) {
    assert.ok(scope.includes(`!${owner}(key)`), `${owner} is excluded from the night's scope`);
  }
});
