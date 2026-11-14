// recheck-543's queue step (scripts/experiments/recheck-543.mjs queueRows) on
// a scratch database: rows go in as pending, the owner's verdicts
// (experiments/recheck-543/owner-verdicts.json) are confirmed through the
// review store, show as decided, and hold over a later grade
// (withOwnerVerdict). Running it twice changes nothing.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { ensureReviewSchema, ownerVerdict, withOwnerVerdict } from "../lib/reviews/store.mjs";
import { queueRows } from "../scripts/experiments/recheck-543.mjs";

let dir;
let db;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "recheck-queue-"));
  db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(db);
  await ensureReviewSchema(db);
  const notPortfolio = JSON.stringify({ is_portfolio: false, rubric_version: 2 });
  for (const url of ["https://www.techinz.dev", "https://andy-bell.design", "https://other.dev"]) {
    await db.execute({ sql: "INSERT INTO portfolios (url, name, status, ai_rubric) VALUES (?, 'x', 'live', ?)", args: [url, notPortfolio] });
  }
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const row = (url, proposed, owner = null) => ({
  batch: "recheck-543",
  url,
  grp: "not_portfolio",
  current: "listed",
  proposed,
  agreed: owner ? 1 : 0,
  reason: owner ? "Owner verdict" : "The graders disagree",
  off_list: 0,
  shot_key: "0123456789abcdef",
  verdicts: JSON.stringify({ prompt: "portfolio-definition-v2.1" }),
  signals: JSON.stringify({ capture: {} }),
  status: "pending",
  created_at: "2026-11-13T23:50:00.000Z",
  ...(owner ? { owner: { action: "confirm", by: "owner:2026-11-13", at: "2026-11-13T23:45:00.000Z" } } : {}),
});

test("owner verdicts are confirmed through the review store and hold over later grades; other rows stay pending", async () => {
  const rows = [row("https://www.techinz.dev", "relist", true), row("https://andy-bell.design", "remove", true), row("https://other.dev", "relist")];
  const r = await queueRows(db, rows, { onFeed: () => true, log: () => {} });
  assert.equal(r.added, 3);
  assert.deepEqual(r.decided.map((x) => [x.url, x.ok]), [["https://www.techinz.dev", true], ["https://andy-bell.design", true]]);
  const status = Object.fromEntries((await db.execute("SELECT url, status, decided_by FROM status_reviews")).rows.map((x) => [x.url, [x.status, x.decided_by]]));
  assert.deepEqual(status["https://www.techinz.dev"], ["confirmed", "owner:2026-11-13"]);
  assert.deepEqual(status["https://andy-bell.design"], ["confirmed", "owner:2026-11-13"]);
  assert.deepEqual(status["https://other.dev"], ["pending", null]);
  assert.equal((await ownerVerdict(db, "https://www.techinz.dev")).isPortfolio, true);
  assert.equal((await ownerVerdict(db, "https://andy-bell.design")).isPortfolio, false);
  // A later grade that says the opposite keeps the owner's verdict.
  assert.equal((await withOwnerVerdict(db, "https://www.techinz.dev", { is_portfolio: false })).is_portfolio, true);
  assert.equal((await withOwnerVerdict(db, "https://andy-bell.design", { is_portfolio: true })).is_portfolio, false);
  // Running the step again adds nothing and decides nothing twice.
  const again = await queueRows(db, rows, { onFeed: () => true, log: () => {} });
  assert.equal(again.added, 0);
  assert.equal(again.updated, 0);
  assert.ok(again.decided.every((x) => x.error === "already decided"));
});

test("a later decision updates a row still pending, never one already decided", async () => {
  // The screenshot check settles other.dev as "retry later": the pending row takes it.
  const retry = { ...row("https://other.dev", "review"), reason: "Could not grade, retry later", status: "rejected", decided_by: "rule:retry-later", decided_at: "2026-11-14T01:00:00.000Z" };
  const r = await queueRows(db, [retry], { onFeed: () => true, log: () => {} });
  assert.equal(r.updated, 1);
  const after = (await db.execute({ sql: "SELECT status, decided_by, reason FROM status_reviews WHERE url = ?", args: ["https://other.dev"] })).rows[0];
  assert.deepEqual([after.status, after.decided_by, after.reason], ["rejected", "rule:retry-later", "Could not grade, retry later"]);
  // The owner's decided rows are not touched by a new row for the same site.
  const r2 = await queueRows(db, [{ ...row("https://andy-bell.design", "relist"), reason: "a grader changed its mind" }], { onFeed: () => true, log: () => {} });
  assert.equal(r2.updated, 0);
  assert.equal((await db.execute({ sql: "SELECT status FROM status_reviews WHERE url = ?", args: ["https://andy-bell.design"] })).rows[0].status, "confirmed");
});
