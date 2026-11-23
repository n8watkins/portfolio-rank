// What a profile reads from Gemini's stored answer (lib/profile.ts
// reportCard): whether it is a portfolio and the roles, for search, and no
// report card on the page (owner, 2026-11-23), for a grade made before v3
// too, which still stores its letter and dropped scores.
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

test("what a profile reads from a grade: whether it is a portfolio and the roles, never a Gemini score or reason (old and new grades)", () => {
  for (const g of [V2, V3]) {
    const r = reportCard(JSON.stringify(g));
    assert.ok(r, "an old grade still reads");
    assert.equal(r.isPortfolio, true);
    assert.deepEqual(r.roles, g.roles);
    assert.equal(r.rubricVersion, g.rubric_version);
    for (const k of ["axes", "reason", "quality", "tier", "aiIsPortfolio"]) assert.equal(k in r, false, k);
    assert.ok(!/polished|clear role|second line|Shows four/.test(JSON.stringify(r)), "no Gemini note or reason leaks");
  }
});

test("no report data for nothing, an error, broken JSON or the owner's keep that waits for a fresh grade", () => {
  assert.equal(reportCard(null), null);
  assert.equal(reportCard(JSON.stringify({ error: "no_usable_captures" })), null);
  assert.equal(reportCard("{not json"), null);
  assert.equal(reportCard({ is_portfolio: true, ai_is_portfolio: false, fresh_grade: "due", source: "owner_review" }), null);
});

test("no profile page shows a Gemini report card (owner, 2026-11-23)", () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  for (const f of ["app/p/[slug]/page.tsx", "app/p/[slug]/profile-v2.tsx"]) {
    const src = read(f);
    assert.ok(!/GeminiOpinion|Five-second test|five_second_test|reportCard\(/.test(src), f);
  }
  assert.equal(fs.existsSync(new URL("../components/profile/GeminiOpinion.tsx", import.meta.url)), false, "the card component is gone");
});
