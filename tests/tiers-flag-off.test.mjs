// Tiers by ELO are shown only with RANKING_V2 (owner decision D2). With the
// flag off (production, and this local production build: scripts/test-e2e.sh
// never sets it) every page renders as before: Gemini's letter, the plain ELO
// and the ELO board, even when the tier data is there in the background. The
// site below gets a top tier-by-ELO row and stored rank, which a page would
// show if it ignored the flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import feed from "../data/feed.json" with { type: "json" };
import { ensureTierSchema, writeTierMeta } from "../lib/tiers-db.mjs";
import { cautious } from "../lib/tiers.mjs";

const BASE = process.env.E2E_BASE_URL;
const DB_URL = process.env.E2E_DB_URL;
const SITE = feed[205].url;

const get = async (path) => {
  const res = await fetch(BASE + path, { redirect: "manual" });
  return { status: res.status, html: await res.text() };
};

/** What only tiers by ELO would show; none of it may appear with the flag off. */
const TIER_MARKERS = [
  "Starting rank from automated checks",
  "Report card: how to improve",
  "real vote",
  "Automated checks:",
  "Quickest points",
  "Your tier comes from your place",
  "Points from automated checks",
  "By tier and ELO",
  "Tier S plus",
  "Tier SSS",
];

test("with RANKING_V2 off, no page shows tiers by ELO, though the tier data is there", { skip: !BASE || !DB_URL }, async () => {
  const db = createClient({ url: DB_URL });
  await ensureTierSchema(db);
  const rank = { tier: "SSS", elo: 1700, faceoffs: 0, votes: 0, top: 1, place: 1, of: 100, provisional: false, seeded: true, points: 95, check: [["perfMobile", 15, 1]] };
  const grade = { tier: "B", is_portfolio: true, visual_design: { score: 4, note: "n" }, five_second_test: { score: 4, note: "n" }, storytelling: { score: 3, note: "n" }, writing: { score: 4, note: "n" }, memorability: { score: 3, note: "n" }, rank };
  await db.execute({
    sql: "INSERT INTO portfolios (url, status, ai_rubric) VALUES (?, 'live', ?) ON CONFLICT(url) DO UPDATE SET ai_rubric = excluded.ai_rubric",
    args: [SITE, JSON.stringify(grade)],
  });
  const r = { mu: 40, sigma: 3 };
  await db.execute({
    sql: "INSERT OR REPLACE INTO tier_ratings (url, mu, sigma, rating, bucket, member, seeded, points, tier) VALUES (?, ?, ?, ?, 0, 1, 1, 95, 'SSS')",
    args: [SITE, r.mu, r.sigma, cautious(r)],
  });
  await writeTierMeta(db, { n: 1, cutoffs: [{ tier: "SSS", min: null }], hist: [[0, 1]], perPoint: 4, at: new Date().toISOString() });

  // The profile: the plain ELO, the AI review with Gemini's own letter (B), no tier card.
  const profile = await get(`/p/${encodeURIComponent(SITE)}`);
  assert.equal(profile.status, 200);
  assert.match(profile.html, /ELO · \d+ votes?/);
  assert.match(profile.html, /AI design review/);
  for (const m of TIER_MARKERS) assert.ok(!profile.html.includes(m), `profile shows "${m}"`);

  // The leaderboard: the ELO board (or its empty state), not the ranked board; no view pages.
  const top = await get("/top");
  assert.equal(top.status, 200);
  assert.ok(/Ranked by ELO from head-to-head face-off votes|No portfolios on this board yet/.test(top.html));
  for (const m of TIER_MARKERS) assert.ok(!top.html.includes(m), `/top shows "${m}"`);
  assert.equal((await get("/top/ai")).status, 404);

  // Home, and How grading works: as before.
  for (const path of ["/", "/grading"]) {
    const page = await get(path);
    assert.equal(page.status, 200);
    for (const m of TIER_MARKERS) assert.ok(!page.html.includes(m), `${path} shows "${m}"`);
  }
});
