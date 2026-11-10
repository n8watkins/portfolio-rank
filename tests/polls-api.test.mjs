// End to end: the polls API on the running production build (`npm run
// test:e2e`): the public read, voting once per visitor (browser cookie and
// account), the Origin check, the rate limit, and that no response says who
// voted for what.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { encode } from "@auth/core/jwt";
import { insertPoll } from "../pipeline/polls.mjs";
import { ensurePollsSchema } from "../lib/polls/schema.mjs";
import { nextWeek, pollWeek } from "../lib/polls/week.mjs";
import feed from "../data/feed.json" with { type: "json" };

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const db = createClient({ url: DB_URL, timeout: 10000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const week = pollWeek(new Date());
// Last week's poll, closed.
const last = pollWeek(new Date(week.opensAt.getTime() - 3600000));

let seq = Math.floor(Math.random() * 1e6);
async function signedIn() {
  const id = String(800000000 + seq++);
  const token = await encode({ token: { raterId: `gh:${id}`, login: `e2e-${id}`, sub: id }, secret: process.env.AUTH_SECRET, salt: "authjs.session-token", maxAge: 3600 });
  return `authjs.session-token=${token}`;
}

function jar(initial = "") {
  const c = new Map(initial ? initial.split("; ").map((kv) => kv.split(/=(.*)/s).slice(0, 2)) : []);
  return {
    header: () => [...c].map(([k, v]) => `${k}=${v}`).join("; "),
    absorb(res) {
      for (const sc of res.headers.getSetCookie?.() ?? []) {
        const [k, v] = sc.split(";")[0].split(/=(.*)/s);
        c.set(k, v);
      }
    },
    get: (k) => c.get(k),
  };
}

async function vote(j, id, body, { origin = BASE, headers = {} } = {}) {
  const res = await fetch(`${BASE}/api/polls/${id}/vote`, {
    method: "POST",
    headers: { cookie: j.header(), "content-type": "application/json", ...(origin ? { origin } : {}), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  j.absorb(res);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text, headers: res.headers };
}

async function mine(j, id) {
  const res = await fetch(`${BASE}/api/polls/${id}/vote`, { headers: { cookie: j.header() } });
  return { status: res.status, body: await res.json(), cache: res.headers.get("cache-control") };
}

before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/polls`)).ok) break;
    } catch {}
    await sleep(1000);
  }
  await ensurePollsSchema(db);
  // A clean slate for this week, last week and next week.
  const ids = [week.id, last.id, nextWeek(week).id];
  await db.batch(
    ids.flatMap((id) => [
      { sql: "DELETE FROM poll_votes WHERE poll_id = ?", args: [id] },
      { sql: "DELETE FROM poll_options WHERE poll_id = ?", args: [id] },
      { sql: "DELETE FROM polls WHERE id = ?", args: [id] },
    ]),
    "write"
  );
  await db.execute("DELETE FROM rate_limits WHERE k LIKE 'poll-vote:%'");
  const now = Date.now();
  await insertPoll(db, {
    week,
    kind: "hero",
    question: "Which hero section is better?",
    detail: "First screen only.",
    options: [{ label: "Left", url: feed[0].url }, { label: "Right", url: feed[1].url }],
    source: "code",
    now,
  });
  await insertPoll(db, { week: last, kind: "text", question: "Dark or light portfolio?", options: [{ label: "Dark" }, { label: "Light" }], source: "code", now });
  await db.execute({ sql: "UPDATE poll_options SET votes = ? WHERE poll_id = ? AND idx = 0", args: [7, last.id] });
  await db.execute({ sql: "UPDATE poll_options SET votes = ? WHERE poll_id = ? AND idx = 1", args: [3, last.id] });
  await insertPoll(db, { week: nextWeek(week), kind: "text", question: "Not open yet?", options: [{ label: "A" }, { label: "B" }], source: "code", now });
});

test("polls API: the public read has this week's poll and past results, never the upcoming one", async () => {
  const res = await fetch(`${BASE}/api/polls`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control"), /public, max-age=60/);
  const body = await res.json();
  assert.equal(body.active.id, week.id);
  assert.equal(body.active.kind, "hero");
  assert.equal(body.active.status, "active");
  assert.deepEqual(body.active.options.map((o) => [o.index, o.label, o.site.url, o.site.name]), [
    [0, "Left", feed[0].url, feed[0].name],
    [1, "Right", feed[1].url, feed[1].name],
  ]);
  assert.equal(body.active.options[0].site.path, `/p/${encodeURIComponent(feed[0].url)}`);
  const past = body.past.find((p) => p.id === last.id);
  assert.equal(past.status, "closed");
  assert.deepEqual(past.options.map((o) => [o.label, o.votes, o.percent]), [["Dark", 7, 70], ["Light", 3, 30]]);
  assert.ok(!JSON.stringify(body).includes("Not open yet"));

  assert.equal((await fetch(`${BASE}/api/polls/${last.id}`)).status, 200);
  assert.equal((await fetch(`${BASE}/api/polls/${nextWeek(week).id}`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/polls/nope`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/polls?past=0`)).status, 200);
});

test("polls API: one vote per browser and per account; the visitor sees their own vote only", async () => {
  const a = jar();
  assert.equal((await mine(a, week.id)).body.mine, null);
  const first = await vote(a, week.id, { option: 1 });
  assert.equal(first.status, 200, first.text);
  assert.ok(a.get("pr_anon"), "the browser gets its signed cookie");
  assert.equal(first.body.mine, 1);
  assert.equal(first.body.poll.total, 1);
  assert.equal(first.body.poll.options[1].votes, 1);
  const again = await vote(a, week.id, { option: 0 });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "already_voted");
  assert.equal(again.body.mine, 1);
  const m = await mine(a, week.id);
  assert.deepEqual(m.body, { mine: 1, open: true, turnstile: false });
  assert.match(m.cache, /no-store/);

  // Signing in on the same browser doesn't give a second vote.
  const user = await signedIn();
  const sameBrowser = jar(`${user}; pr_anon=${a.get("pr_anon")}`);
  assert.equal((await vote(sameBrowser, week.id, { option: 0 })).status, 409);
  // A new account on a new browser votes; the same account elsewhere doesn't.
  const other = await signedIn();
  assert.equal((await vote(jar(other), week.id, { option: 0 })).status, 200);
  const elsewhere = jar(other);
  assert.equal((await vote(elsewhere, week.id, { option: 1 })).status, 409);
  assert.equal((await mine(jar(other), week.id)).body.mine, 0, "a signed-in account sees its vote on any browser");

  // Totals only: nothing names a voter.
  const pub = await (await fetch(`${BASE}/api/polls/${week.id}`)).text();
  assert.doesNotMatch(pub + first.text + again.text, /anon:|gh:|voter|browser/);
  assert.equal(JSON.parse(pub).poll.total, 2);
});

test("polls API: Origin check, bad input, closed and upcoming polls", async () => {
  const j = jar();
  assert.equal((await vote(j, week.id, { option: 0 }, { origin: null })).status, 403);
  assert.equal((await vote(j, week.id, { option: 0 }, { origin: "https://evil.example" })).body.error, "bad_origin");
  assert.equal((await vote(j, week.id, "{not json")).status, 400);
  assert.equal((await vote(j, week.id, { option: "0" })).status, 400);
  assert.equal((await vote(j, week.id, { option: 5 })).body.error, "bad_option");
  assert.equal((await vote(j, last.id, { option: 0 })).status, 410);
  assert.equal((await vote(j, nextWeek(week).id, { option: 0 })).status, 404);
  assert.equal((await vote(j, "2001-01-01", { option: 0 })).status, 404);
});

test("polls API: vote attempts are rate limited per browser", async () => {
  const j = jar();
  const statuses = [];
  for (let i = 0; i < 21; i++) statuses.push((await vote(j, week.id, { option: 0 })).status);
  assert.deepEqual(statuses.slice(0, 2), [200, 409]);
  assert.equal(statuses[20], 429);
  const r = await vote(j, week.id, { option: 0 });
  assert.equal(r.body.error, "rate_limited");
  assert.ok(Number(r.headers.get("retry-after")) > 0);
});
