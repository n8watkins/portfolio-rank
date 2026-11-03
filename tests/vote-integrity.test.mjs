// End-to-end vote-integrity tests: they drive a running production build
// (`next build && next start`) over HTTP, the way an attacker would, and read
// the ratings back from its database. Run with `npm run test:e2e` (see
// scripts/test-e2e.sh), which builds, starts the app on a throwaway local
// database and points these tests at it.
//
// Each test reproduces an attack from the November 2026 audit:
//   - voting on a pair the server never served (self-promotion),
//   - redrawing matchups without limit until a chosen site comes up,
//   - claiming practice votes from a forged anon cookie,
//   - claim then undo to move ratings with no vote left behind.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { encode } from "@auth/core/jwt";
import { randomUUID } from "node:crypto";
import feed from "../data/feed.json" with { type: "json" };

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const db = createClient({ url: DB_URL });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PACE = 2100; // the server rejects a rater's votes closer than 2s apart

let accountSeq = Math.floor(Math.random() * 1e6);
async function signedIn() {
  const id = String(900000000 + accountSeq++);
  const token = await encode({
    token: { raterId: `gh:${id}`, login: `e2e-${id}`, sub: id },
    secret: process.env.AUTH_SECRET,
    salt: "authjs.session-token",
    maxAge: 3600,
  });
  return { raterId: `gh:${id}`, cookie: `authjs.session-token=${token}` };
}

/** A browser-like cookie jar: keeps whatever cookies the server sets. */
function jar(initial = "") {
  const c = new Map(initial ? initial.split("; ").map((kv) => kv.split(/=(.*)/s).slice(0, 2)) : []);
  return {
    header: () => [...c].map(([k, v]) => `${k}=${v}`).join("; "),
    absorb(res) {
      for (const sc of res.headers.getSetCookie?.() ?? []) {
        const [kv] = sc.split(";");
        const [k, v] = kv.split(/=(.*)/s);
        if (v === "" || /max-age=0|expires=thu, 01 jan 1970/i.test(sc)) c.delete(k);
        else c.set(k, v);
      }
    },
    set: (k, v) => c.set(k, v),
  };
}

async function call(j, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { cookie: j.header(), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  j.absorb(res);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function elo(url) {
  const r = await db.execute({ sql: "SELECT elo, votes FROM ratings WHERE url = ?", args: [url] });
  return r.rows[0] ? { elo: Number(r.rows[0].elo), votes: Number(r.rows[0].votes) } : { elo: 1200, votes: 0 };
}

const TARGET = feed[0].url;
const OTHERS = feed.slice(40, 60).map((p) => p.url);

before(async () => {
  // Wait for the server (the runner starts it just before the tests).
  for (let i = 0; i < 60; i++) {
    try {
      // /api/rank creates the schema on a fresh database.
      if ((await fetch(BASE + "/api/rank")).ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`no server at ${BASE}`);
});

test("a signed-in vote on a pair the server never served is rejected", async () => {
  const me = await signedIn();
  const j = jar(me.cookie);
  const before = await elo(TARGET);
  for (const loser of OTHERS.slice(0, 3)) {
    const r = await call(j, "POST", "/api/rank", { winner: TARGET, loser });
    assert.equal(r.status, 403, `expected 403, got ${r.status} ${JSON.stringify(r.body)}`);
    await sleep(PACE);
  }
  assert.deepEqual(await elo(TARGET), before);
});

test("a token for one served pair cannot be spent on another pair", async () => {
  const me = await signedIn();
  const j = jar(me.cookie);
  const served = await call(j, "GET", "/api/rank");
  assert.equal(served.status, 200);
  const loser = [served.body.a.url, served.body.b.url].includes(OTHERS[5]) ? OTHERS[6] : OTHERS[5];
  const r = await call(j, "POST", "/api/rank", { winner: TARGET, loser, token: served.body.token });
  assert.equal(r.status, 403);
});

test("voting on the served pair counts, once", async () => {
  const me = await signedIn();
  const j = jar(me.cookie);
  const s = await call(j, "GET", "/api/rank");
  const { a, b, token } = s.body;
  const w0 = await elo(a.url);
  const v = await call(j, "POST", "/api/rank", { winner: a.url, loser: b.url, token });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.official, true);
  assert.equal((await elo(a.url)).elo, w0.elo + v.body.delta);
  await sleep(PACE);
  const again = await call(j, "POST", "/api/rank", { winner: b.url, loser: a.url, token });
  assert.ok(again.status === 403 || again.status === 409, `replay got ${again.status}`);
});

test("signed-in raters cannot redraw matchups without limit", async () => {
  const me = await signedIn();
  const j = jar(me.cookie);
  let limited = false;
  for (let i = 0; i < 200 && !limited; i++) {
    const r = await call(j, "GET", "/api/rank");
    if (r.status === 429) limited = true;
    else assert.equal(r.status, 200);
  }
  assert.ok(limited, "200 draws in a row were all served");
});

test("votes closer than 2 seconds apart are rejected", async () => {
  const me = await signedIn();
  const j = jar(me.cookie);
  const s1 = await call(j, "GET", "/api/rank");
  const v1 = await call(j, "POST", "/api/rank", { winner: s1.body.a.url, loser: s1.body.b.url, token: s1.body.token });
  assert.equal(v1.status, 200);
  const s2 = await call(j, "GET", "/api/rank");
  const v2 = await call(j, "POST", "/api/rank", { winner: s2.body.a.url, loser: s2.body.b.url, token: s2.body.token });
  assert.equal(v2.status, 429);
});

test("a forged practice cookie claims nothing", async () => {
  // Practice votes cast under a cookie value the server never issued.
  const forged = randomUUID();
  const anon = jar(`pr_anon=${forged}`);
  const s = await call(anon, "GET", "/api/rank");
  await call(anon, "POST", "/api/rank", { winner: s.body.a.url, loser: s.body.b.url, token: s.body.token });
  const me = await signedIn();
  const j = jar(`${me.cookie}; pr_anon=${forged}`);
  const c = await call(j, "POST", "/api/claim");
  assert.equal(c.body?.claimed ?? 0, 0, JSON.stringify(c.body));
});

test("claim then undo leaves ratings exactly where they started", async () => {
  const me = await signedIn();
  const start = new Map();
  for (let i = 0; i < 3; i++) {
    // A real visitor: the server issues the practice cookie.
    const anon = jar();
    const s = await call(anon, "GET", "/api/rank");
    assert.equal(s.status, 200);
    const { a, b, token } = s.body;
    for (const u of [a.url, b.url]) if (!start.has(u)) start.set(u, await elo(u));
    const pv = await call(anon, "POST", "/api/rank", { winner: a.url, loser: b.url, token });
    assert.equal(pv.status, 200, JSON.stringify(pv.body));
    assert.equal(pv.body.official, false);

    const j = jar(`${me.cookie}; ${anon.header()}`);
    const c = await call(j, "POST", "/api/claim");
    assert.equal(c.status, 200);
    const u = await call(jar(me.cookie), "POST", "/api/rank/undo");
    assert.equal(u.status, 200, JSON.stringify(u.body));
    await sleep(PACE);
  }
  for (const [url, e] of start) assert.equal((await elo(url)).elo, e.elo, `${url} drifted`);
  const left = await db.execute({ sql: "SELECT COUNT(*) AS n FROM votes WHERE rater_id = ?", args: [me.raterId] });
  assert.equal(Number(left.rows[0].n), 0);
});

test("a practice token cannot be used by a different visitor", async () => {
  const a1 = jar();
  const s = await call(a1, "GET", "/api/rank");
  const a2 = jar();
  await call(a2, "GET", "/api/rank"); // gets its own cookie
  const r = await call(a2, "POST", "/api/rank", { winner: s.body.a.url, loser: s.body.b.url, token: s.body.token });
  assert.equal(r.status, 403);
});
