// Shared by the door's tests (tests/portfolio-door-*.test.mjs): a throwaway
// database with the night's tables, sites with evidence, a Gemini stand-in
// that answers per site, the night engine driven as the Workflow drives it,
// and a database wrapper that counts statements and can make some fail.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { ensureRosterSchema, NOT_PORTFOLIO } from "../../pipeline/roster.mjs";
import { HIDDEN_WHERE } from "../../lib/hidden.mjs";
import { budgetPlan } from "../../pipeline/budget.mjs";
import { ensureGeminiLog } from "../../pipeline/gemini-log.mjs";
import { PRIMARY_MODEL, BACKUP_MODEL } from "../../pipeline/gemini.mjs";
import { AI_CRITERIA } from "../../pipeline/rubric.mjs";
import { SIGNAL_NAMES } from "../../pipeline/portfolio-guard.mjs";
import { finishNight, planNight, runBatch, startNight } from "../../pipeline/night.mjs";
import { ensureRubricHistory } from "../../pipeline/rubric-history.mjs";
import { ensureRankingSchema } from "../../lib/ranking/store.mjs";
import { rankingConfig } from "../../lib/ranking/config.mjs";

export const T0 = Date.parse("2026-11-17T04:30:00Z"); // 20:30 Pacific on 2026-11-16
export const DAY = 86400000;
export const answer = (isPortfolio) => ({
  is_portfolio: isPortfolio,
  tier: isPortfolio ? "B" : "D",
  ...Object.fromEntries(AI_CRITERIA.map((c) => [c.id, { score: isPortfolio ? 3 : 1, note: isPortfolio ? "fine" : `no work shown (${c.id})` }])),
});
export const signals = (n) => ({ ...Object.fromEntries(SIGNAL_NAMES.map((k, i) => [k, i < n])), score: n });
export const PORTFOLIO_HTML = `<!doctype html><html><head><title>Ann Lee | Engineer</title></head><body><h1>Ann Lee</h1>
  <a href="#projects">Projects</a><a href="#about">About me</a><a href="mailto:a@b.dev">Contact</a><a href="/resume.pdf">Resume</a>
  <a href="https://github.com/annlee">GitHub</a><p>${"I build accessible web apps for small teams. ".repeat(10)}</p></body></html>`;
/** A page with no portfolio signals at all. */
export const EMPTY_HTML = `<!doctype html><html><head><title>Welcome</title></head><body><p>${"Lorem ipsum dolor sit amet. ".repeat(20)}</p></body></html>`;

/** `health: false` leaves out health_marks, as on a database from before the not-working pool. */
export async function freshDb({ health = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "door-"));
  const file = path.join(dir, "db.sqlite");
  const db = createClient({ url: `file:${file}` });
  await ensureRosterSchema(db);
  if (!health) {
    await db.execute("DROP TRIGGER IF EXISTS health_marks_follow_purge");
    await db.execute("DROP TABLE IF EXISTS health_marks");
  }
  await ensureGeminiLog(db);
  await ensureRankingSchema(db);
  await ensureRubricHistory(db);
  await db.execute(`CREATE TABLE votes (id INTEGER PRIMARY KEY AUTOINCREMENT, winner TEXT NOT NULL, loser TEXT NOT NULL,
       pair_key TEXT, rater_type TEXT NOT NULL DEFAULT 'anon', rater_id TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')), delta INTEGER, starred INTEGER NOT NULL DEFAULT 0, model TEXT)`);
  return { db, dir, file };
}

let k = 0;
/** A listed, captured site with evidence; `n` signals in its facts, or none at all with n = null. */
export async function site(db, url, { name = "Ann Lee", text = "Hi, I build things.", n = 2, rubric = null, status = "live", reason = "", needsReview = 0, healthSignals = null, captured = true } = {}) {
  await db.execute({
    sql: `INSERT INTO portfolios (url, name, status, reason, shot_key, captured_at, ai_rubric, page_text, facts, meta, needs_review, signals)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{"motion":false}', ?, ?)`,
    args: [
      url,
      name,
      status,
      reason,
      captured ? `k${++k}` : null,
      captured ? "2026-11-16 12:00:00" : null,
      rubric == null ? null : JSON.stringify(rubric),
      text,
      JSON.stringify({ source: "http", measured_at: "2026-11-16T00:00:00Z", ...(n == null ? {} : { signals: signals(n) }) }),
      needsReview,
      healthSignals == null ? null : JSON.stringify(healthSignals),
    ],
  });
}

export function mockGemini(byUrl, { onCall } = {}) {
  return async (_u, init) => {
    const body = String(init.body);
    await onCall?.(body);
    const hit = Object.keys(byUrl).find((u) => body.includes(`url: ${u}`));
    const a = hit ? byUrl[hit] : answer(true);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(a) }] }, finishReason: "STOP" }], usageMetadata: {} }), { status: 200 });
  };
}

export function context(db, { gemini = {}, autoApply = true, start = T0, budget = {}, fetchImpl } = {}) {
  const clock = { t: start };
  return {
    clock,
    ctx: {
      db,
      apiKey: "test-key-not-real",
      plan: budgetPlan(JSON.stringify(budget)),
      quota: { [PRIMARY_MODEL]: 500, [BACKUP_MODEL]: 500 },
      rpm: 30,
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
      log: () => {},
      fetchImpl: fetchImpl ?? mockGemini(gemini),
      image: async () => ({ inline_data: { mime_type: "image/jpeg", data: "AAAA" } }),
      // pollGeneration: the content stage's weekly poll has its own switch (default off); these nights run with it on.
      flags: { rankingV2: false, rubricRegrade: false, reviewAutoApply: autoApply, pollGeneration: "true", ranking: rankingConfig({}) },
      runId: "test",
    },
  };
}

export async function drive(ctx, clock) {
  let state = await startNight(ctx);
  state = await planNight(ctx, state);
  let steps = 0;
  while (!state.done && steps++ < 200) {
    const r = await runBatch(ctx, state);
    state = r.state;
    if (r.pauseMs) clock.t += r.pauseMs;
  }
  return { state, ...(await finishNight(ctx, state)) };
}

/** The database with some statements made to fail, and every statement counted. */
export function faulty(db, { failBatch = () => false, failExecute = () => false } = {}) {
  const seen = [];
  // Round trips to the database: one per execute, one per batch.
  const trips = { n: 0 };
  const text = (s) => (typeof s === "string" ? s : s.sql);
  return {
    seen,
    trips,
    db: new Proxy(db, {
      get(target, prop) {
        if (prop === "execute") {
          return async (s) => {
            trips.n++;
            seen.push(text(s));
            if (failExecute(text(s))) throw new Error("injected failure");
            return target.execute(s);
          };
        }
        if (prop === "batch") {
          return async (stmts, mode) => {
            trips.n++;
            for (const s of stmts) seen.push(text(s));
            if (failBatch(stmts.map(text))) throw new Error("injected failure");
            return target.batch(stmts, mode);
          };
        }
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    }),
  };
}

export const grade = async (db, url) => {
  const r = (await db.execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [url] })).rows[0];
  return r?.ai_rubric == null ? null : JSON.parse(String(r.ai_rubric));
};
export const hidden = async (db, url) => Number((await db.execute({ sql: `SELECT COUNT(*) AS n FROM portfolios WHERE url = ? AND (${HIDDEN_WHERE})`, args: [url] })).rows[0].n) === 1;
export const notPortfolio = async (db, url) => Number((await db.execute({ sql: `SELECT ${NOT_PORTFOLIO()} AS n FROM portfolios WHERE url = ?`, args: [url] })).rows[0].n) === 1;
export const reviewsOf = async (db, url) => (await db.execute({ sql: "SELECT * FROM status_reviews WHERE url = ? ORDER BY id", args: [url] })).rows;
export const col = async (db, url, c) => (await db.execute({ sql: `SELECT ${c} AS v FROM portfolios WHERE url = ?`, args: [url] })).rows[0]?.v;
