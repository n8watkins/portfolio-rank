// lib/db.ts: a deployed Worker without TURSO_DATABASE_URL fails with a clear
// error instead of falling back to a local file (Sentry PORTFOLIORANK-2);
// off the Workers (next dev, next start in the tests) the local file stays.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "pr-db-client-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const saved = { url: process.env.TURSO_DATABASE_URL, file: process.env.LOCAL_DB_FILE };
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
after(() => {
  if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
  if (saved.url === undefined) delete process.env.TURSO_DATABASE_URL;
  else process.env.TURSO_DATABASE_URL = saved.url;
  if (saved.file === undefined) delete process.env.LOCAL_DB_FILE;
  else process.env.LOCAL_DB_FILE = saved.file;
});

function asWorkers(on) {
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: on ? "Cloudflare-Workers" : "Node.js/24" }, configurable: true, writable: true });
}

// Each case gets the module fresh, since it keeps one client per isolate.
let n = 0;
const load = () => import(`../lib/db.ts?case=${n++}`);

test("on the Workers without TURSO_DATABASE_URL, the first query's client says what is missing", async () => {
  delete process.env.TURSO_DATABASE_URL;
  asWorkers(true);
  const { db, MISSING_DATABASE_URL } = await load();
  assert.throws(() => db(), { message: MISSING_DATABASE_URL });
});

test("off the Workers, a missing TURSO_DATABASE_URL means the local file, as before", async () => {
  delete process.env.TURSO_DATABASE_URL;
  process.env.LOCAL_DB_FILE = path.join(dir, "local.db");
  asWorkers(false);
  const { db } = await load();
  const rows = (await db().execute("SELECT 1 AS one")).rows;
  assert.equal(Number(rows[0].one), 1);
});
