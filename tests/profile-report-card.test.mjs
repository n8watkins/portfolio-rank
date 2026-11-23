// The profile's Gemini report card (lib/profile.ts reportCard) under rubric
// v3: only the three kept outputs (is it a portfolio and why, the five-second
// test, the roles), for a grade made before v3 too, which still stores its
// letter, its four dropped scores and its quality score (owner, 2026-11-22).
// Offline: lib/profile.ts loaded the way Next does, no database touched.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

// Lets this file import lib/profile.ts the way Next does: "@/..." from the
// repository root, extensionless TypeScript, and JSON as a default export.
register(
  "data:text/javascript," +
    encodeURIComponent(`
const root = ${JSON.stringify(new URL("../", import.meta.url).href)};
const EXT = ["", ".ts", ".tsx", ".mjs", ".js"];
export async function resolve(specifier, context, next) {
  const local = specifier.startsWith("@/") ? root + specifier.slice(2) : /^\\.\\.?\\//.test(specifier) && context.parentURL?.endsWith(".ts") ? new URL(specifier, context.parentURL).href : null;
  if (!local) return next(specifier, context);
  let last;
  for (const ext of EXT) {
    try {
      return await next(local + ext, context);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
export async function load(url, context, next) {
  if (!url.endsWith(".json")) return next(url, context);
  const r = await next(url, { ...context, format: "json", importAttributes: { type: "json" } });
  return { format: "module", source: "export default " + String(r.source), shortCircuit: true };
}`)
);

process.env.LOCAL_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "profile-report-card-")), "db.sqlite");
delete process.env.TURSO_DATABASE_URL;

let reportCard;
before(async () => {
  ({ reportCard } = await import("../lib/profile.ts"));
});

const V2 = {
  is_portfolio: true,
  tier: "S",
  visual_design: { score: 5, note: "polished" },
  five_second_test: { score: 4, note: "clear role" },
  storytelling: { score: 2, note: "bare lists" },
  writing: { score: 5, note: "crisp" },
  memorability: { score: 5, note: "memorable" },
  roles: ["frontend developer", "designer"],
  rubric_version: 2,
  quality_score: 4.3,
  checks_score: 82,
  model: "gemini-3.5-flash-lite",
  judged_at: "2026-11-15T00:00:00.000Z",
};
const V3 = {
  portfolio_reason: "Shows four web apps she built",
  is_portfolio: true,
  five_second_test: { score: 3, note: "role only in the second line" },
  roles: ["full stack developer"],
  rubric_version: 3,
  checks_score: 64,
  model: "gemini-3.5-flash-lite",
  judged_at: "2026-11-23T00:00:00.000Z",
};

test("an old v2 grade still renders, with only the kept outputs: no letter, no quality score, no dropped axis", () => {
  const r = reportCard(JSON.stringify(V2));
  assert.ok(r, "an old grade still has a report card");
  assert.deepEqual(r.axes, [{ key: "five_second_test", label: "Five-second test", score: 4, note: "clear role" }]);
  assert.deepEqual(r.roles, ["frontend developer", "designer"]);
  assert.equal(r.isPortfolio, true);
  assert.equal(r.aiIsPortfolio, true);
  assert.equal(r.reason, "", "an old grade had no reason");
  assert.equal(r.rubricVersion, 2);
  assert.equal(r.judgedAt, "2026-11-15T00:00:00.000Z");
  assert.equal(r.checks, 82);
  for (const k of ["quality", "tier"]) assert.equal(k in r, false, k);
  assert.ok(!JSON.stringify(r).includes("polished"), "no dropped note leaks");
});

test("a v3 grade renders its reason, its five-second test and its roles", () => {
  const r = reportCard(V3);
  assert.equal(r.reason, "Shows four web apps she built");
  assert.equal(r.rubricVersion, 3);
  assert.deepEqual(r.axes.map((a) => a.key), ["five_second_test"]);
  assert.deepEqual(r.roles, ["full stack developer"]);
});

test("Gemini's own 'no' shows as its answer even while a hold keeps the site listed", () => {
  const r = reportCard({ ...V3, is_portfolio: true, ai_is_portfolio: false, portfolio_reason: "A GitHub profile, not a site" });
  assert.equal(r.isPortfolio, true);
  assert.equal(r.aiIsPortfolio, false);
});

test("no report card for nothing, an error, broken JSON or the owner's keep that waits for a fresh grade", () => {
  assert.equal(reportCard(null), null);
  assert.equal(reportCard(JSON.stringify({ error: "no_usable_captures" })), null);
  assert.equal(reportCard("{not json"), null);
  assert.equal(reportCard({ is_portfolio: true, ai_is_portfolio: false, fresh_grade: "due", source: "owner_review" }), null);
});
