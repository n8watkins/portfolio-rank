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
import { sessionCookie } from "./helpers/session.mjs";
import { randomUUID } from "node:crypto";
import feed from "../data/feed.json" with { type: "json" };

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
// Shares the server's SQLite file: wait for its locks instead of SQLITE_BUSY.
const db = createClient({ url: DB_URL, timeout: 10000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PACE = 2100; // the server rejects a rater's votes closer than 2s apart

let accountSeq = Math.floor(Math.random() * 1e6);
async function signedIn({ ageDays } = {}) {
  const id = 900000000 + accountSeq++;
  return { raterId: `gh:${id}`, cookie: await sessionCookie({ id, ageDays }) };
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

// Like a browser, every call but a GET carries this site's Origin unless a
// test forges another (or none).
async function call(j, method, path, body, { origin = BASE } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { cookie: j.header(), ...(body ? { "content-type": "application/json" } : {}), ...(origin && method !== "GET" ? { origin } : {}) },
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

test("practice visitors cannot redraw matchups without limit either", async () => {
  const anon = jar();
  let limited = null;
  for (let i = 0; i < 100 && !limited; i++) {
    const r = await call(anon, "GET", "/api/rank");
    if (r.status === 429) limited = r.body;
    else assert.equal(r.status, 200);
  }
  assert.ok(limited, "100 practice draws in a row were all served");
  assert.equal(limited.error, "signin_required");
});

test("a practice vote must be for the pair drawn last, not an older one", async () => {
  const anon = jar();
  const first = await call(anon, "GET", "/api/rank");
  await call(anon, "GET", "/api/rank"); // a newer draw replaces it
  const { a, b, token } = first.body;
  const r = await call(anon, "POST", "/api/rank", { winner: a.url, loser: b.url, token });
  assert.equal(r.status, 403, JSON.stringify(r.body));
});

test("concurrent claims can't convert more than the lifetime allowance", async () => {
  // Two practice visitors cast 6 votes each (12 > the allowance of 10), then
  // the same account claims both at once.
  const visitors = [jar(), jar()];
  await Promise.all(
    visitors.map(async (anon) => {
      for (let i = 0; i < 6; i++) {
        const s = await call(anon, "GET", "/api/rank");
        const v = await call(anon, "POST", "/api/rank", { winner: s.body.a.url, loser: s.body.b.url, token: s.body.token });
        assert.equal(v.status, 200, JSON.stringify(v.body));
        await sleep(PACE);
      }
    })
  );
  const me = await signedIn();
  const claims = await Promise.all(
    visitors.map((anon) => call(jar(`${me.cookie}; ${anon.header()}`), "POST", "/api/claim"))
  );
  const total = claims.reduce((n, c) => n + (c.body?.claimed ?? 0), 0);
  assert.ok(total <= 10, `claimed ${total}`);
  const rows = await db.execute({ sql: "SELECT COUNT(*) AS n FROM votes WHERE rater_id = ? AND claimed = 1", args: [me.raterId] });
  assert.ok(Number(rows.rows[0].n) <= 10, `${rows.rows[0].n} claimed rows`);
});

test("votes from GitHub accounts younger than 30 days don't count, nor do their claimed practice votes", async () => {
  for (const ageDays of [3, null]) {
    // null: a session from before the account date was recorded.
    const me = await signedIn({ ageDays });
    const j = jar(me.cookie);
    const s = await call(j, "GET", "/api/rank");
    const w0 = await elo(s.body.a.url);
    const v = await call(j, "POST", "/api/rank", { winner: s.body.a.url, loser: s.body.b.url, token: s.body.token });
    assert.equal(v.status, 403, JSON.stringify(v.body));
    assert.equal(v.body.error, "account_too_new");
    assert.deepEqual(await elo(s.body.a.url), w0);
  }
  // Practice votes wait for the account to be old enough.
  const anon = jar();
  const s = await call(anon, "GET", "/api/rank");
  assert.equal((await call(anon, "POST", "/api/rank", { winner: s.body.a.url, loser: s.body.b.url, token: s.body.token })).status, 200);
  const young = await signedIn({ ageDays: 29 });
  const c = await call(jar(`${young.cookie}; ${anon.header()}`), "POST", "/api/claim");
  assert.equal(c.body.error, "account_too_new");
  assert.equal(c.body.claimed, 0);
});

test("cookie-authenticated writes refuse another site's Origin, or none", async () => {
  const me = await signedIn();
  const j = jar(me.cookie);
  const s = await call(j, "GET", "/api/rank");
  const vote = { winner: s.body.a.url, loser: s.body.b.url, token: s.body.token };
  // A sibling app on *.n8builds.dev is same-site, so SameSite=Lax lets the cookie through.
  for (const origin of ["https://evil.n8builds.dev", null]) {
    const writes = [
      ["POST", "/api/rank", vote],
      ["POST", "/api/rank/undo"],
      ["POST", "/api/claim"],
      ["POST", "/api/likes", { url: TARGET }],
      ["POST", "/api/lists", { name: "Forged" }],
      ["PATCH", "/api/lists/1", { name: "Forged" }],
      ["DELETE", "/api/lists/1"],
      ["POST", "/api/lists/1/items", { url: TARGET }],
      ["DELETE", "/api/lists/1/items", { url: TARGET }],
      ["POST", "/api/lists/1/trash", { action: "restore" }],
    ];
    for (const [method, path, body] of writes) {
      const r = await call(j, method, path, body, { origin });
      assert.equal(r.status, 403, `${method} ${path} from ${origin}: ${r.status}`);
      assert.equal(r.body?.error, "bad_origin", `${method} ${path}`);
    }
  }
  const votes = await db.execute({ sql: "SELECT COUNT(*) AS n FROM votes WHERE rater_id = ?", args: [me.raterId] });
  assert.equal(Number(votes.rows[0].n), 0);
  const lists = await db.execute({ sql: "SELECT COUNT(*) AS n FROM lists WHERE owner = ?", args: [me.raterId] });
  assert.equal(Number(lists.rows[0].n), 0);
});
