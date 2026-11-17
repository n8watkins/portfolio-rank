// End to end on the running production build (scripts/test-e2e.sh): a listed
// site that stops working is hidden by the health check's own runs (the
// nightly check and the hourly re-check, pipeline/not-working.mjs, with the
// site's answers stubbed and a simulated clock): its profile answers the
// site's normal not-found page, and the leaderboard does not list it; when
// it works again, both are back.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import feed from "../data/feed.json" with { type: "json" };
import { migrate } from "../lib/schema.mjs";
import { assignShownRanks, ensureRankingSchema } from "../lib/ranking/store.mjs";
import { runHealthCheck } from "../pipeline/health.mjs";
import { runRecheck } from "../pipeline/recheck.mjs";
import { sessionCookie } from "./helpers/session.mjs";
import { purgeGoneProfiles } from "../pipeline/not-working.mjs";
import { INTERNAL_TOKEN_HEADER, REVALIDATE_PROFILES, internalToken } from "../lib/internal-token.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const db = createClient({ url: DB_URL, timeout: 10000 });

before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + "/");
      await migrate(db);
      await ensureRankingSchema(db);
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no server at ${BASE}`);
});

// A listed site from the middle of the list that no other test renders (profiles are kept 5 minutes).
const plain = feed.filter((p) => !new URL(p.url).search && new URL(p.url).pathname.replace(/\/+$/, "") === "");
const target = plain[Math.floor(plain.length / 2) + 7];
const pathOf = (url) => `/p/${encodeURIComponent(url)}`;
const rubric = JSON.stringify({ tier: "A", is_portfolio: true, roles: ["frontend developer"], visual_design: { score: 4, note: "Clean." } });

const H = 3600000;
const D = 86400000;
const F = Date.parse("2026-11-18T04:30:00Z");
const quiet = () => {};
const response = (status, body, url) => ({ status, ok: status >= 200 && status < 300, url, text: async () => body });
let answering = true;
const page = `<!doctype html><html><head><title>${target.name}</title></head><body><h1>${target.name}</h1><a href="#projects">Projects</a><a href="#about">About</a><p>${"I build web apps. ".repeat(20)}</p></body></html>`;
const fetchImpl = async (u) => (answering ? response(200, page, u) : response(402, "This deployment is temporarily paused", u));
const render = async (u) =>
  answering
    ? { status: 200, finalUrl: u, title: target.name, text: `${target.name} builds web apps.`, media: false, html: page }
    : { status: 402, finalUrl: u, title: "", text: "This deployment is temporarily paused", media: false, html: "" };

/** The Worker's hourly purge path (worker/index.ts purgeAfterHour), tick after tick, until no mark is left. */
async function purgeUntilSettled() {
  const token = await internalToken(process.env.AUTH_SECRET ?? "", REVALIDATE_PROFILES);
  const revalidate = async (urls) => {
    const res = await fetch(`${BASE}/api/internal/revalidate-profiles`, { method: "POST", headers: { "content-type": "application/json", [INTERNAL_TOKEN_HEADER]: token }, body: JSON.stringify({ urls }) });
    assert.equal(res.status, 200);
  };
  const seen = [];
  const origin = async (url) => {
    const status = (await fetch(BASE + pathOf(url))).status;
    seen.push(status);
    return status;
  };
  for (let tick = 0; tick < 6; tick++) {
    const out = await purgeGoneProfiles(db, { purge: async () => true, origin, revalidate });
    if (!out.waiting.length && !out.failed.length) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.fail(`the app never answered as it should (answers: ${seen.join(", ")})`);
}

let n = 0;
/** The board as a visitor's request reads it (a new limit each time, so no cached answer is reused). */
const board = async () => {
  const res = await fetch(`${BASE}/api/leaderboard?view=ai&limit=${400 + ++n}`);
  assert.equal(res.status, 200);
  return (await res.json()).rows.map((r) => r.url);
};

test("a site that stopped working: its profile is the not-found page and the leaderboard leaves it out; it comes back by itself", async () => {
  await db.execute({
    sql: `INSERT INTO portfolios (url, name, status, ai_rubric) VALUES (?, ?, 'live', ?)
          ON CONFLICT(url) DO UPDATE SET status = 'live', health = NULL, health_fails = 0, health_first_fail_at = NULL, delisted_at = NULL, ai_rubric = excluded.ai_rubric`,
    args: [target.url, target.name, rubric],
  });
  await db.execute({ sql: "DELETE FROM health_marks WHERE url = ?", args: [target.url] });
  await db.execute({
    sql: `INSERT INTO site_ratings (view, url, rank, mu, sigma, confidence, comparisons, wins, losses, tier) VALUES ('ai', ?, 0, 40, 2, 'confident', 9, 9, 0, 'S')
          ON CONFLICT(view, url) DO UPDATE SET rank = 0, mu = 40`,
    args: [target.url],
  });
  // The board as the nightly recompute leaves it: the shown sites numbered.
  await assignShownRanks(db);
  const site = [{ url: target.url, name: target.name }];
  // Live: the nightly check passes; the board shows it, and the profile is rendered once, so the app keeps a
  // cached copy of it (5 minutes), as on the site.
  await runHealthCheck({ db, feed: site, fetchImpl, render, now: new Date(F - D), log: quiet });
  assert.ok((await board()).includes(target.url), "on the board while it works");
  assert.equal((await fetch(BASE + pathOf(target.url))).status, 200, "the profile while it works");

  // Paused hosting: the nightly check fails it, the hour's re-check and the next day's fail it too.
  answering = false;
  await runHealthCheck({ db, feed: site, fetchImpl, render, now: new Date(F), log: quiet });
  assert.ok((await board()).includes(target.url), "still shown after one failure");
  await runRecheck({ db, fetchImpl, render, now: new Date(F + H), controls: 0, log: quiet });
  const s = await runRecheck({ db, fetchImpl, render, now: new Date(F + D), controls: 0, log: quiet });
  assert.deepEqual(s.newlyHidden.map((x) => x.url), [target.url]);

  // The hourly purge path (the Worker's, here against the app directly): the app drops its cached copy,
  // is asked for the page, the edge copy is purged; repeated until the app answers not found.
  await purgeUntilSettled();
  for (const n of [1, 2]) assert.equal((await fetch(BASE + pathOf(target.url))).status, 404, `request ${n} after the purge`);
  const gone = await fetch(BASE + pathOf(target.url));
  assert.equal(gone.status, 404);
  const html = await gone.text();
  assert.match(html, /That page isn(&#x27;|')t here\./, "the site's normal not-found page");
  assert.ok(!html.includes(`Visit ${new URL(target.url).hostname.replace(/^www\./, "")}`), "nothing of the profile");
  assert.ok(!(await board()).includes(target.url), "not on the board");
  // Its owner can still prove it is theirs and manage the listing (POST /api/owner/verify reads loadProfile).
  const cookie = await sessionCookie({ id: 760000001, login: "not-working-owner" });
  const verify = await fetch(`${BASE}/api/owner/verify`, {
    method: "POST",
    headers: { cookie, origin: BASE, "cf-connecting-ip": "198.51.100.77", "content-type": "application/json" },
    body: JSON.stringify({ url: target.url, method: "start" }),
  });
  const verified = await verify.json();
  assert.equal(verify.status, 200, JSON.stringify(verified));
  assert.equal(verified.claim.url, target.url);

  // It works again: the next re-check brings it back, as it was.
  answering = true;
  await db.execute({ sql: "UPDATE health_marks SET pool_next_at = ? WHERE url = ?", args: [new Date(F + 2 * D).toISOString(), target.url] });
  const back = await runRecheck({ db, fetchImpl, render, now: new Date(F + 2 * D), controls: 0, log: quiet });
  assert.deepEqual(back.returned.map((x) => x.url), [target.url]);
  assert.ok((await board()).includes(target.url), "back on the board");
  // The same purge path brings the page back: the app's cached not-found goes too.
  await purgeUntilSettled();
  for (const n of [1, 2]) assert.equal((await fetch(BASE + pathOf(target.url))).status, 200, `request ${n} after it came back`);
  assert.equal(String((await db.execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [target.url] })).rows[0].ai_rubric), rubric, "its grade is as it was");
});
