// A profile (lib/profile.ts loadProfile, what /p/<address> renders) finds a
// site by siteKeyOf, so /p/jane.dev/?x, /p/jane.dev/#x and /p/jane.dev/Work
// are jane.dev's profile. A removal or a hidden grade asked under any
// spelling of the site must apply to every one of them
// (lib/ownership/same-site.mjs). Offline: a throwaway SQLite file, the real
// list (data/feed.json), no server, no network.
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

process.env.LOCAL_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "owner-profile-")), "db.sqlite");
delete process.env.TURSO_DATABASE_URL;

const T0 = new Date("2026-11-16T18:00:00Z");
let db, loadProfile, claims, addPending;
before(async () => {
  ({ db } = await import("../lib/db.ts"));
  ({ loadProfile } = await import("../lib/profile.ts"));
  claims = await import("../lib/games/claims.mjs");
  ({ addPending } = await import("../lib/discovery/sites.mjs"));
  await (await import("../lib/db.ts")).ensureSchema();
});

/** A claim on `url` with control proof, then the action. */
async function act(url, action, now = T0) {
  const claim = await claims.openClaim(db(), { url, owner: "gh:1", login: "owner", token: "tok_owner_aaaaaaaa", now: T0 });
  if (claim.status !== "verified") await claims.setClaimStatus(db(), { claim, status: "verified", method: "file", actor: "gh:1", now: T0 });
  const out = await claims.ownerAction(db(), { url, owner: "gh:1", action, now });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out;
}

const removeNow = async (url) => {
  await act(url, "remove");
  assert.deepEqual(await claims.applyDueRemovals(db(), { now: new Date(T0.getTime() + claims.REMOVAL_HOLD_MS + 1) }), [url]);
};

test("a removal under one spelling: the profile under ?x, #x and another path case answers as removed", async () => {
  await addPending(db(), { url: "https://added-own.dev/", source: "tools" });
  await addPending(db(), { url: "https://added-own.dev/work", source: "tools" });
  const spellings = ["https://added-own.dev/?x=1", "https://added-own.dev/#x", "http://www.added-own.dev"];
  for (const u of [...spellings, "https://added-own.dev/Work"]) assert.ok(await loadProfile(u), `${u} has a profile before`);

  await removeNow("https://added-own.dev/");
  for (const u of spellings) assert.equal(await loadProfile(u), null, u);
  assert.ok(await loadProfile("https://added-own.dev/Work"), "another path is another site");

  await removeNow("https://added-own.dev/work");
  assert.equal(await loadProfile("https://added-own.dev/Work"), null, "the path's case is the same site");
});

test("a listed site whose address carries a fragment: removed under the bare spelling, its profile is gone", async () => {
  const listed = "https://ethanlanting.dev/#home";
  assert.ok((await loadProfile(listed))?.listed, "on the list");
  await removeNow("https://ethanlanting.dev/");
  assert.equal(await loadProfile(listed), null);
});

test("a hidden grade under one spelling stays hidden on the profile under another, query included", async () => {
  const listed = "https://paco.fyi?utm_source=gh";
  await db().execute({ sql: "INSERT INTO portfolios (url, name, status) VALUES (?, 'Paco', 'live') ON CONFLICT(url) DO NOTHING", args: [listed] });
  assert.equal((await loadProfile(listed))?.hideGrade, false);
  await act("https://www.paco.fyi/", "hide_grade");
  const p = await loadProfile(listed);
  assert.equal(p?.hideGrade, true);
  assert.equal(p?.report, null);

  await addPending(db(), { url: "https://graded-own.dev/", source: "tools" });
  await act("https://graded-own.dev/", "hide_grade");
  assert.equal((await loadProfile("https://graded-own.dev/#about"))?.hideGrade, true);
});
