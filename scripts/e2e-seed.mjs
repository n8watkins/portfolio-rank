// Seeds the fresh e2e database (scripts/test-e2e.sh) with what a deployed
// site always has: a library of graded portfolios. The face-off only draws
// graded sites (app/api/rank), so without these there would be no pairs.
// GRADED_SEED feed sites from a fixed slice, with grades spread over the
// tiers; tests that need a site ungraded use indices outside the slice.
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import feed from "../data/feed.json" with { type: "json" };

/** The slice of data/feed.json graded in every e2e run (feed indices). */
export const GRADED_FROM = 1200;
export const GRADED_SEED = 80;
const TIERS = ["S", "A", "A", "B", "B", "B", "C", "C", "D"];

export function seedGrade(i) {
  const tier = TIERS[i % TIERS.length];
  return JSON.stringify({ tier, quality_score: 40 + (i % 50), rubric_version: 2, model: "gemini-3.5-flash-lite", is_portfolio: true, judged_at: "2026-11-01T00:00:00.000Z" });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.E2E_DB_URL;
  if (!url) throw new Error("E2E_DB_URL is not set");
  const db = createClient({ url });
  await migrate(db);
  const rows = feed.slice(GRADED_FROM, GRADED_FROM + GRADED_SEED);
  await db.batch(
    rows.map((p, i) => ({
      sql: "INSERT INTO portfolios (url, name, status, ai_rubric) VALUES (?, ?, 'live', ?) ON CONFLICT(url) DO UPDATE SET ai_rubric = excluded.ai_rubric",
      args: [p.url, p.name ?? null, seedGrade(i)],
    })),
    "write"
  );
  console.log(`e2e seed: ${rows.length} graded portfolios`);
}
