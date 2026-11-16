// Shared by the content engine tests: the fixture database (60 graded sites
// and three that must never be named), the Monday night, a mocked Gemini
// answering by request schema, and the stage context.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../../lib/schema.mjs";
import { ensureRosterSchema } from "../../pipeline/roster.mjs";
import { ensureRubricHistory } from "../../pipeline/rubric-history.mjs";
import { ensureRankingSchema } from "../../lib/ranking/store.mjs";
import { ensureGeminiLog } from "../../pipeline/gemini-log.mjs";
import { PRIMARY_MODEL } from "../../pipeline/gemini.mjs";
import { topGrades } from "../../pipeline/content/facts.mjs";
import { mockAnswer } from "../../pipeline/content/mock-writer.mjs";
import { TOPICS } from "../../pipeline/content/topic.mjs";

export const MONDAY = Date.parse("2026-11-17T04:30:00Z");
export const SUNDAY = Date.parse("2026-11-16T04:30:00Z");
export const TUESDAY = Date.parse("2026-11-18T04:30:00Z");
export const AXES = ["visual_design", "five_second_test", "storytelling", "writing", "memorability", "motion"];
export const hex = (n) => n.toString(16).padStart(16, "0");

export const rubric = (tier, score, over = {}) => ({
  is_portfolio: true,
  tier,
  model: PRIMARY_MODEL,
  rubric_version: 2,
  ...Object.fromEntries(AXES.map((k) => [k, { score, note: "n" }])),
  ...over,
});

export async function fixture({ motion = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "content-"));
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(db);
  await ensureRosterSchema(db);
  await ensureRubricHistory(db);
  await ensureRankingSchema(db);
  await ensureGeminiLog(db);
  const add = async ({ url, name, tier, score, meta = {}, delisted = null, over = {} }) =>
    db.execute({
      sql: "INSERT INTO portfolios (url, name, status, shot_key, ai_rubric, meta, delisted_at) VALUES (?, ?, 'live', ?, ?, ?, ?)",
      args: [url, name, hex(url.length * 7919 + name.length), JSON.stringify(rubric(tier, score, over)), JSON.stringify({ darkMode: true, motion: true, overflow390: false, bytes: 900000, requests: 30, consoleErrors: 0, ...meta }), delisted],
    });
  for (let i = 1; i <= 30; i++) await add({ url: `https://top-${i}.dev`, name: `Top Person ${i}`, tier: i <= 8 ? "S" : "A", score: i <= 8 ? 5 : 4, over: motion ? { motion: { score: motion[0], note: "n" } } : {} });
  for (let i = 1; i <= 30; i++) await add({ url: `https://low-${i}.dev`, name: `Low Person ${i}`, tier: ["B", "C", "D"][i % 3], score: 2, meta: { darkMode: false, overflow390: true, consoleErrors: 3, bytes: 4000000 }, over: motion ? { motion: { score: motion[1], note: "n" } } : {} });
  // Best-scoring of all, but removed by its owner, delisted, or not a portfolio: never named.
  await add({ url: "https://removed-star.dev", name: "Removed Star", tier: "S", score: 5, over: { writing: { score: 5 } } });
  await db.execute("INSERT INTO portfolio_owner (url, removed_at, updated_at) VALUES ('https://removed-star.dev', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')");
  await add({ url: "https://delisted-star.dev", name: "Delisted Star", tier: "S", score: 5, delisted: "2026-11-01" });
  await add({ url: "https://not-a-portfolio.dev", name: "Not Aportfolio", tier: "S", score: 5, over: { is_portfolio: false } });
  return db;
}

export async function sheetAndRoster(opts = { motion: [2, 1] }) {
  const db = await fixture(opts);
  const sheet = await topGrades(db, { now: MONDAY });
  const roster = (await db.execute("SELECT name, url FROM portfolios")).rows.map((r) => ({ name: String(r.name), url: String(r.url) }));
  return { db, sheet, roster };
}

export function fakeGemini(answers) {
  const calls = [];
  const kindOf = (schema) => {
    // No schema: the plain-text writer (compose.mjs): a write, or the one fix call.
    if (!schema) return "write";
    const p = schema?.properties ?? {};
    if (p.claims) return "claims";
    if (p.verdicts) return "judge";
    if (p.on_topic) return "review";
    if (p.ideas) return "pick";
    if (p.choice) return "image";
    if (p.polls) return "polls";
    return "unknown";
  };
  const counts = {};
  return {
    calls,
    requests: { [PRIMARY_MODEL]: 0 },
    async generate(parts, schema, options) {
      const kind = kindOf(schema);
      const n = (counts[kind] = (counts[kind] ?? 0) + 1);
      calls.push({ kind, parts, options });
      this.requests[PRIMARY_MODEL]++;
      // The writer answers with the deterministic mock (pipeline/content/mock-writer.mjs) unless a test says otherwise.
      const a = answers[kind] ?? (kind === "write" ? (_n, p) => mockAnswer({ parts: p }) : undefined);
      const result = typeof a === "function" ? await a(n, parts) : a;
      if (result === undefined) throw new Error(`no mocked answer for ${kind}`);
      return { result, model: PRIMARY_MODEL, usage: {} };
    },
  };
}

export const REVIEW_OK = { topic: TOPICS[1], on_topic: true, positive: true, names_ok: true, voice_ok: true, problems: [] };

export function contentCtx(db, { now = MONDAY, mode = "dry-run", keys = {}, ai = null, fetchImpl, store } = {}) {
  const stored = new Map();
  return {
    stored,
    ctx: {
      db,
      now: () => now,
      log: () => {},
      fetchImpl: fetchImpl ?? (async () => new Response("ok", { status: 200 })),
      flags: { contentMode: mode },
      content: { env: "test", keys, ai, store: store ?? (async (key, bytes) => (stored.set(key, bytes), key)) },
      runId: "test",
    },
  };
}
