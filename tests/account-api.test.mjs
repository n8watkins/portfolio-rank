// The account API (GET and DELETE /api/account) end to end against the
// running production build (scripts/test-e2e.sh): a grade requested while
// signed in is stored under the grader's keyed id for the account, and the
// download and the deletion both find it there.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createClient } from "@libsql/client";
import { encode } from "@auth/core/jwt";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const db = createClient({ url: DB_URL, timeout: 10000 });

// lib/grader/server.ts keyed("visitor", <rater id>), with the run's AUTH_SECRET.
const keyedVisitor = (id) => createHmac("sha256", process.env.AUTH_SECRET).update(`grader-visitor\n${id}`).digest("base64url").slice(0, 22);

before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE + "/api/rank")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no server at ${BASE}`);
});

test("account: the download and the deletion include grades requested while signed in", async () => {
  const n = 960000000 + Math.floor(Math.random() * 1e6);
  const login = `e2e-acct-${n}`;
  const token = await encode({ token: { raterId: `gh:${n}`, login, sub: String(n) }, secret: process.env.AUTH_SECRET, salt: "authjs.session-token", maxAge: 3600 });
  const cookie = `authjs.session-token=${token}`;
  const job = `acct${n}`;
  const now = new Date().toISOString();
  await db.execute({
    sql: "INSERT INTO grade_jobs (id, url, site_key, status, visitor, network, created_at, updated_at) VALUES (?, 'https://acct-e2e.dev', 'acct-e2e.dev', 'done', ?, 'net', ?, ?)",
    args: [job, keyedVisitor(`gh:${n}`), now, now],
  });

  const data = await (await fetch(`${BASE}/api/account`, { headers: { cookie } })).json();
  assert.deepEqual(data.tables.grade_jobs?.map((j) => j.id), [job]);

  const res = await fetch(`${BASE}/api/account`, { method: "DELETE", headers: { cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ confirm: login }) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).deleted.grade_jobs, 1);
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS n FROM grade_jobs WHERE id = ?", args: [job] })).rows[0].n, 0);
});
