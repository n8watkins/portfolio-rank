// The 2026-11-16 audit of the weekly health check (pipeline/health.mjs,
// pipeline/gate.mjs, pipeline/render.mjs, pipeline/exclusions.mjs): it took
// live sites off the list by mistake. One test or more per finding, each
// written to fail on the code before the fix. Offline: fetch and the browser
// are stand-ins, the database is a throwaway local file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import * as gate from "../pipeline/gate.mjs";
import * as health from "../pipeline/health.mjs";
import * as exclusions from "../pipeline/exclusions.mjs";
import * as render from "../pipeline/render.mjs";
import { BOT_WALL_REASON } from "../pipeline/capture-blocked.mjs";
import { autoApplyReviews, ensureReviewSchema, undoReviews } from "../lib/reviews/store.mjs";
import { DAY, PORTFOLIO_HTML, T0, col, freshDb, reviewsOf, site } from "./helpers/door-night.mjs";

const quiet = () => {};
const at = (days) => new Date(T0 + days * DAY);
const weeks = [0, 7, 14];
const filler = Array.from({ length: 30 }, (_, i) => ({ url: `https://filler-${i}.dev`, name: "Filler Person" }));

const headerOf = (init, name) => {
  const h = init?.headers ?? {};
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? String(h[key]) : "";
};
const chromeOf = (init) => Number(headerOf(init, "user-agent").match(/Chrome\/(\d+)/)?.[1] ?? 0);
const response = (status, body, url) => ({ status, ok: status >= 200 && status < 300, url, text: async () => body });
const socketClosed = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
const goodPage = (url) => ({ status: 200, finalUrl: `${url}/`, title: "Ann Lee | Engineer", text: "Ann Lee builds web apps. Projects, about and contact.", media: false, html: PORTFOLIO_HTML });

// ---------------------------------------------------------------------------
// a. The pinned User-Agent

test("a: the User-Agent names a current Chrome, worked out from the date, never the pinned Chrome/124", () => {
  assert.equal(typeof gate.chromeMajor, "function", "gate.mjs works the version out (chromeMajor)");
  assert.doesNotMatch(gate.UA, /Chrome\/124\./);
  assert.ok(gate.chromeMajor(Date.parse("2026-11-16")) >= 141, "at least the Chrome 141 the blocked sites accepted");
  assert.ok(gate.chromeMajor(Date.parse("2028-11-16")) >= gate.chromeMajor(Date.parse("2026-11-16")) + 20, "it keeps moving with the date");
  assert.match(gate.UA, /^Mozilla\/5\.0 .* Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
});

test("a: a site that drops the connection for an old Chrome passes the plain request now", async () => {
  // www.adhamdannaway.com, remyjouni.dev, www.chicagoitsystems.com, Floriscodes.nl: socket closed for Chrome/124, 200 for 125+.
  const url = "https://www.adhamdannaway.example";
  const fetchImpl = async (u, init) => {
    if (chromeOf(init) < 125) throw socketClosed();
    return response(200, PORTFOLIO_HTML, u);
  };
  const render = async () => {
    throw new Error("page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://www.adhamdannaway.example/");
  };
  const r = await health.checkSite({ url, name: "Ann Lee" }, { fetchImpl, render });
  assert.equal(r.ok, true, r.reason);
});

test("a: a dropped connection that the browser cannot get past either is inconclusive, never a failed check", async () => {
  const fetchImpl = async () => {
    throw socketClosed();
  };
  const render = async () => {
    throw new Error("page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://reset.example/");
  };
  const r = await health.checkSite({ url: "https://reset.example", name: "Ann Lee" }, { fetchImpl, render });
  assert.equal(r.ok, null, r.reason);
  // A refused connection is what a site that is really down looks like: still a failure.
  const refused = await health.checkSite(
    { url: "https://refused.example", name: "Ann Lee" },
    {
      fetchImpl: async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      },
      render: async () => {
        throw new Error("page.goto: net::ERR_CONNECTION_REFUSED at https://refused.example/");
      },
    }
  );
  assert.equal(refused.ok, false);
});

test("a: the browser second opinion sends its own engine's version as a visitor's Chrome, not the pinned string", () => {
  assert.equal(typeof render.browserUserAgent, "function");
  const ua = render.browserUserAgent("158.0.8127.18");
  assert.match(ua, /Chrome\/158\.0\.0\.0/);
  assert.doesNotMatch(ua, /Headless/);
  assert.match(render.browserUserAgent(undefined), /Chrome\/\d+/, "falls back to the date's version");
});

test("a: on the wire, the plain request carries a browser's Accept and Accept-Language, and no header pair a browser never sends", async () => {
  // juanbenito.vercel.app (2026-11-16): HTTP 500 "Internal Server Error" (21 bytes) to a request with only a User-Agent,
  // HTTP 200 with Accept and Accept-Language. A real local server, since Node's fetch rewrites some headers.
  const server = http.createServer((req, res) => {
    const browserLike = /text\/html/.test(String(req.headers.accept)) && /en-US/.test(String(req.headers["accept-language"]));
    res.writeHead(browserLike ? 200 : 500, { "content-type": browserLike ? "text/html" : "text/plain" });
    res.end(browserLike ? `<html><body><pre>${JSON.stringify(req.headers)}</pre>${"<p>Ann Lee builds web apps.</p>".repeat(5)}</body></html>` : "Internal Server Error");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const g = await gate.httpGate(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(g.status, "live", g.reason);
    const wire = JSON.parse(g.html.match(/<pre>(.*?)<\/pre>/)[1].replace(/&quot;/g, '"'));
    assert.match(wire["user-agent"], /Chrome\/\d+\.0\.0\.0/);
    // Node's fetch sends sec-fetch-mode "cors"; beside it, sec-fetch-dest "document" or upgrade-insecure-requests would mark a fake.
    assert.equal(wire["sec-fetch-dest"], undefined);
    assert.equal(wire["upgrade-insecure-requests"], undefined);
  } finally {
    server.close();
  }
  // And a 5xx gets the browser's second opinion before it counts.
  const r = await health.checkSite({ url: "https://five.example", name: "Ann Lee" }, { fetchImpl: async (u) => response(500, "Internal Server Error", u), render: async (u) => goodPage(u) });
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------
// b. A slow page body, and a crash of the check

const slowBody = (u) => ({
  status: 200,
  ok: true,
  url: u,
  text: async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  },
});

test("b: a slow page body is a timeout the browser looks at, not a crash and not a failed check", async () => {
  const g = await gate.httpGate("https://jocker.example", { fetchImpl: async (u) => slowBody(u) });
  assert.equal(g.status, "error");
  assert.equal(g.transient, true);
  let renders = 0;
  const r = await health.checkSite({ url: "https://jocker.example", name: "Ann Lee" }, { fetchImpl: async (u) => slowBody(u), render: async (u) => (renders++, goodPage(u)) });
  assert.equal(r.ok, true);
  assert.equal(renders, 1);
  // Without a browser, a timeout says nothing about the site.
  const blind = await health.checkSite({ url: "https://jocker.example", name: "Ann Lee" }, { fetchImpl: async (u) => slowBody(u) });
  assert.equal(blind.ok, null);
  // The browser timing out too: still nothing learned.
  const both = await health.checkSite(
    { url: "https://jocker.example", name: "Ann Lee" },
    {
      fetchImpl: async (u) => slowBody(u),
      render: async () => {
        throw new Error("page.goto: Timeout 30000ms exceeded.");
      },
    }
  );
  assert.equal(both.ok, null);
});

test("b: three weekly checks that time out or crash never take a site down", async () => {
  const { db } = await freshDb();
  const url = "https://sheriff.example";
  const feed = [{ url, name: "Ann Lee" }];
  // A stand-in answer whose address can't be read: the check's own code throws.
  const crash = async () => ({
    status: 200,
    ok: true,
    get url() {
      throw new Error("boom");
    },
    text: async () => "",
  });
  for (const [i, w] of weeks.entries()) {
    await health.runHealthCheck({ db, feed, fetchImpl: i === 1 ? crash : async (u) => slowBody(u), now: at(w), log: quiet });
  }
  assert.notEqual(await col(db, url, "health"), "down");
  assert.equal(Number(await col(db, url, "health_fails") ?? 0), 0);
});

// ---------------------------------------------------------------------------
// c. Bot walls

test("c: a wall the capture recognises is a wall here too, whatever its status (HTTP 406 'Verifying you are human')", async () => {
  assert.equal(typeof health.isBotWallPage, "function");
  const fetchImpl = async (u) => response(406, "<title>Verifying you are human</title><p>This may take a few seconds.</p>", u);
  const page = { status: 406, finalUrl: "https://walled.example/", title: "Verifying you are human", text: "Verifying you are human. This may take a few seconds.", media: false, html: "" };
  const r = await health.checkSite({ url: "https://walled.example", name: "Ann Lee" }, { fetchImpl, render: async () => page });
  assert.equal(r.ok, null, r.reason);
  const blind = await health.checkSite({ url: "https://walled.example", name: "Ann Lee" }, { fetchImpl });
  assert.equal(blind.ok, null, blind.reason);
});

test("c: a site whose capture met a bot wall is never counted down or excluded, whatever the check sees", async () => {
  const { db } = await freshDb();
  const walled = "https://walled.example";
  const gone = "https://walled-404.example";
  await site(db, walled, { status: "error", reason: BOT_WALL_REASON, needsReview: 1, captured: false });
  await site(db, gone, { status: "error", reason: `${BOT_WALL_REASON} (3 tries)`, needsReview: 1, captured: false });
  const feed = [{ url: walled, name: "Ann Lee" }, { url: gone, name: "Ann Lee" }, ...filler];
  const fetchImpl = async (u) => {
    if (u.startsWith(walled)) return response(406, "<title>Verifying you are human</title>", u);
    if (u.startsWith(gone)) return response(404, "Not found", u);
    return response(200, PORTFOLIO_HTML, u);
  };
  const render = async (u) => (u.startsWith(walled) ? { status: 406, finalUrl: `${walled}/`, title: "Verifying you are human", text: "Verifying you are human.", media: false, html: "" } : goodPage(u));
  for (const w of weeks) await health.runHealthCheck({ db, feed, fetchImpl, render, now: at(w), log: quiet });
  for (const u of [walled, gone]) {
    assert.notEqual(await col(db, u, "health"), "down", u);
    assert.equal(Number(await col(db, u, "health_fails") ?? 0), 0, u);
    assert.equal(Number(await col(db, u, "needs_review")), 1, `${u} keeps its mark for the owner`);
  }
  // Even a row marked down by an older run is never exported.
  await db.execute({ sql: "UPDATE portfolios SET health = 'down', health_reason = 'HTTP 406', health_fails = 3 WHERE url = ?", args: [walled] });
  const plan = await exclusions.planExclusions({ db, excluded: [], feed, now: at(15) });
  assert.deepEqual(plan.added.map((a) => a.url), []);
});

// ---------------------------------------------------------------------------
// d. The race with the nightly capture and with /admin/review

test("d: a good capture during the run is not failed a third time on the stale reason, nor exported", async () => {
  const { db } = await freshDb();
  const url = "https://gated.example";
  await site(db, url, { status: "error", reason: "capture blocked: still a gate or loader after the click-through" });
  await db.execute({ sql: "UPDATE portfolios SET health = 'suspect', health_fails = 2, health_first_fail_at = ? WHERE url = ?", args: [at(-14).toISOString(), url] });
  const feed = [{ url, name: "Ann Lee" }, ...filler];
  let captured = false;
  const fetchImpl = async (u) => {
    if (!captured) {
      captured = true;
      // The nightly capture gets a good capture while the health run is checking.
      await db.execute({ sql: "UPDATE portfolios SET status = 'live', reason = '' WHERE url = ?", args: [url] });
    }
    return response(200, PORTFOLIO_HTML, u);
  };
  const s = await health.runHealthCheck({ db, feed, fetchImpl, now: at(0), concurrency: 1, log: quiet });
  assert.deepEqual(s.newlyDown, []);
  assert.notEqual(await col(db, url, "health"), "down");
  const plan = await exclusions.planExclusions({ db, excluded: [], feed, now: at(0) });
  assert.deepEqual(plan.added.map((a) => a.url), []);
});

test("d: a decision made in /admin/review during the run is never overwritten", async () => {
  const { db } = await freshDb();
  const url = "https://failing.example";
  await site(db, url);
  await db.execute({ sql: "UPDATE portfolios SET health = 'suspect', health_fails = 2, health_reason = 'HTTP 500', health_first_fail_at = ? WHERE url = ?", args: [at(-14).toISOString(), url] });
  const feed = [{ url, name: "Ann Lee" }, ...filler];
  let decided = false;
  const fetchImpl = async (u) => {
    if (u.startsWith(url)) {
      if (!decided) {
        decided = true;
        // The owner sets the site back to live while the run checks it (what an Undo or a relist writes).
        await db.execute({ sql: "UPDATE portfolios SET health = 'live', health_fails = 0, health_reason = NULL, health_first_fail_at = NULL WHERE url = ?", args: [url] });
      }
      return response(500, "Internal Server Error", u);
    }
    return response(200, PORTFOLIO_HTML, u);
  };
  const render = async (u) => (u.startsWith(url) ? { status: 500, finalUrl: `${url}/`, title: "", text: "", media: false, html: "" } : goodPage(u));
  await health.runHealthCheck({ db, feed, fetchImpl, render, now: at(0), concurrency: 1, log: quiet });
  // Counted from the owner's state (a first failure), not from the snapshot's two.
  assert.deepEqual([await col(db, url, "health"), Number(await col(db, url, "health_fails"))], ["suspect", 1]);

  // A decision that lands after the run has read the rows, just before it writes: the write stands back.
  await db.execute({ sql: "UPDATE portfolios SET health = 'suspect', health_fails = 2, health_reason = 'HTTP 500', health_first_fail_at = ? WHERE url = ?", args: [at(-7).toISOString(), url] });
  let raced = false;
  const racing = new Proxy(db, {
    get(target, prop) {
      if (prop !== "execute") return typeof target[prop] === "function" ? target[prop].bind(target) : target[prop];
      return async (q) => {
        const out = await target.execute(q);
        if (!raced && /AS decided_removal/.test(typeof q === "string" ? q : q.sql)) {
          raced = true;
          await target.execute({ sql: "UPDATE portfolios SET health = 'live', health_fails = 0, health_reason = NULL, health_first_fail_at = NULL WHERE url = ?", args: [url] });
        }
        return out;
      };
    },
  });
  // The site is on the not-working ladder now, so the hourly re-check is the one that looks at it.
  const s = await health.runHealthCheck({ db: racing, feed, scheduled: "check", fetchImpl: async (u) => (u.startsWith(url) ? response(500, "Internal Server Error", u) : response(200, PORTFOLIO_HTML, u)), render, now: at(7), concurrency: 1, log: quiet });
  assert.ok(raced);
  assert.equal(await col(db, url, "health"), "live");
  assert.ok(s.changedDuringRun?.includes(url), "reported, for the next check");
});

// ---------------------------------------------------------------------------
// e. A "not a portfolio" grade from before the review queue

const legacyGrade = { is_portfolio: false, tier: "D", model: "gemini-3.1-flash-lite", judged_at: "2026-09-01T00:00:00Z", visual_design: { score: 2, note: "No work shown" } };

test("e: an old 'not a portfolio' grade on a page that loads goes through the review queue, with a record and Undo, never silently", async () => {
  const { db } = await freshDb();
  const url = "https://old-no.example";
  await site(db, url, { rubric: legacyGrade, n: 1 });
  const feed = [{ url, name: "Ann Lee" }, ...filler];
  const fetchImpl = async (u) => response(200, PORTFOLIO_HTML, u);
  for (const w of weeks) await health.runHealthCheck({ db, feed, fetchImpl, now: at(w), log: quiet });
  assert.notEqual(await col(db, url, "health"), "down", "the health check never takes it off for its grade");
  const silent = await exclusions.planExclusions({ db, excluded: [], feed, now: at(14) });
  assert.deepEqual(silent.added.map((a) => a.url), [], "nothing leaves the list without a record");
  const rows = await reviewsOf(db, url);
  assert.equal(rows.length, 1, "one record, written once over three weekly checks");
  assert.equal(String(rows[0].grp), "door_not_portfolio");
  assert.equal(String(rows[0].status), "pending");
  // The hourly rule removes it the recorded way; the export says who decided, and Undo brings it back.
  const applied = await autoApplyReviews(db, { onFeed: () => true, now: at(14.1) });
  assert.deepEqual(applied.map((a) => a.ok), [true]);
  const plan = await exclusions.planExclusions({ db, excluded: [], feed, now: at(14.2) });
  assert.equal(plan.added.length, 1);
  assert.equal(plan.added[0].kind, "not_portfolio");
  assert.equal(plan.added[0].decided_by, "rule:gemini-not-portfolio");
  const undone = await undoReviews(db, { ids: [Number(rows[0].id)], actor: "admin:owner", now: at(14.3) });
  assert.deepEqual(undone.map((u) => u.ok), [true]);
  assert.notEqual(await col(db, url, "health"), "down");
});

test("e: a site down for 'not a portfolio' with no decision on record is not exported", async () => {
  const { db } = await freshDb();
  const url = "https://down-no-record.example";
  await site(db, url, { rubric: legacyGrade });
  await db.execute({ sql: "UPDATE portfolios SET health = 'down', health_reason = 'AI grading says this is not a portfolio', health_fails = 3 WHERE url = ?", args: [url] });
  const plan = await exclusions.planExclusions({ db, excluded: [], feed: [{ url, name: "Ann Lee" }, ...filler], now: at(0) });
  assert.deepEqual(plan.added.map((a) => a.url), []);
  assert.deepEqual(plan.held?.map((h) => h.url), [url]);
});

// ---------------------------------------------------------------------------
// f. Smaller findings

test("f: a temporary DNS failure (EAI_AGAIN) is retried and inconclusive, not dead at once", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "EAI_AGAIN" } });
  };
  const g = await gate.httpGate("https://fine.example", { fetchImpl });
  assert.notEqual(g.status, "dead");
  calls = 0;
  const r = await health.checkSite({ url: "https://fine.example", name: "Ann Lee" }, { fetchImpl });
  assert.equal(r.ok, null);
  assert.equal(calls, 2, "retried once");
  // A name that does not exist (ENOTFOUND) is still dead.
  const nx = await gate.httpGate("https://nx.example", {
    fetchImpl: async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    },
  });
  assert.equal(nx.status, "dead");
});

test("f: failed checks count on distinct weeks: two runs on one bad day and one 13 days later are two, not three", () => {
  // A page that answers with the wrong thing (one that does not answer has the not-working pool's ladder).
  const fail = { ok: false, reason: "renders blank" };
  let s = health.nextHealth(null, fail, at(0));
  s = health.nextHealth(s, fail, at(0.4));
  s = health.nextHealth(s, fail, at(13));
  assert.deepEqual([s.health, s.fails], ["suspect", 2]);
  // The weekly cadence, even a run that starts a day early, still confirms in three weeks.
  let w = health.nextHealth(null, fail, at(0));
  w = health.nextHealth(w, fail, at(6.5));
  w = health.nextHealth(w, fail, at(13.1));
  assert.deepEqual([w.health, w.fails], ["down", 3]);
});

test("f: the summary says needs-review sites go to the owner, not the grading queue", () => {
  const md = health.healthSummary({ aborted: false, checked: 1, live: 1, suspect: 0, down: 0, recovered: 0, inconclusive: [], newlyDown: [], moved: [], needsReview: [{ url: "https://x.example", score: 1 }] });
  assert.doesNotMatch(md, /grading queue/);
  assert.match(md, /owner/);
});

// ---------------------------------------------------------------------------
// Removed "down" sites come back by themselves (owner, 2026-11-16)

test("a removed 'down' site is checked again monthly and leaves the exclusion list when it answers", async () => {
  const now = new Date("2026-12-20T00:00:00Z");
  const list = [
    { url: "https://paused.example", kind: "down", reason: "HTTP 402: deployment paused", removed: "2026-11-16" },
    { url: "https://still-paused.example", kind: "down", reason: "HTTP 402: deployment paused", removed: "2026-11-16" },
    { url: "https://recent.example", kind: "down", reason: "HTTP 500", removed: "2026-12-10" },
    { url: "https://np.example", kind: "not_portfolio", removed: "2026-01-01" },
  ];
  const checked = [];
  const r = await exclusions.planDeadRecheck({ excluded: list, now, answers: async (u) => (checked.push(u), u === "https://paused.example") });
  assert.deepEqual(checked, ["https://paused.example", "https://still-paused.example"], "due 30 days after removal; never a not_portfolio entry");
  assert.deepEqual(r.back, ["https://paused.example"]);
  const still = r.excluded.find((e) => e.url === "https://still-paused.example");
  assert.equal(still.recheck_after, "2027-01-19");
  assert.equal(still.last_checked, "2026-12-20");
  // Capped a run, like the dead entries.
  assert.equal((await exclusions.planDeadRecheck({ excluded: list, now, answers: async () => false, limit: 1 })).still.length, 1);
});

test("a paused deployment and a missing deployment are recorded with their own reason; a paused page never counts as back", async () => {
  const paused = await gate.httpGate("https://paused.example", { fetchImpl: async (u) => response(402, "This deployment is temporarily paused", u) });
  assert.equal(paused.reason, "HTTP 402: deployment paused");
  const missing = await gate.httpGate("https://nic.example", { fetchImpl: async (u) => response(404, "The deployment could not be found on Vercel. DEPLOYMENT_NOT_FOUND", u) });
  assert.deepEqual([missing.status, missing.reason], ["dead", "HTTP 404: deployment not found"]);
  const r = await health.checkSite({ url: "https://paused.example", name: "Ann Lee" }, {
    fetchImpl: async (u) => response(402, "This deployment is temporarily paused", u),
    render: async (u) => ({ status: 402, finalUrl: `${u}/`, title: "", text: "This deployment is temporarily paused", media: false, html: "" }),
  });
  assert.deepEqual([r.ok, r.reason], [false, "HTTP 402: deployment paused"]);
});

// ---------------------------------------------------------------------------
// The code review of pull request #247 (findings numbered as in the review)

const connectTimeout = () =>
  Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("Connect Timeout Error"), { name: "ConnectTimeoutError", code: "UND_ERR_CONNECT_TIMEOUT" }) });
const browserThrows = (message) => async () => {
  throw new Error(message);
};

test("review 1: a connect timeout is a real failure, and a definite browser answer is never overridden by a plain request that only timed out", async () => {
  const g = await gate.httpGate("https://gone.example", {
    fetchImpl: async () => {
      throw connectTimeout();
    },
  });
  assert.equal(g.status, "error");
  assert.notEqual(g.transient, true, "nothing answers at the address: not transient");
  const site = { url: "https://gone.example", name: "Ann Lee" };
  const gone = await health.checkSite(site, {
    fetchImpl: async () => {
      throw connectTimeout();
    },
    render: browserThrows("page.goto: net::ERR_CONNECTION_TIMED_OUT at https://gone.example/"),
  });
  assert.equal(gone.ok, false, gone.reason);
  // The plain request was definite, the browser only timed out: still a failure.
  const slowBrowser = await health.checkSite(site, {
    fetchImpl: async () => {
      throw connectTimeout();
    },
    render: browserThrows("page.goto: Timeout 30000ms exceeded."),
  });
  assert.equal(slowBrowser.ok, false, slowBrowser.reason);
  // The plain request timed out (transient), the browser was refused (definite): the browser decides.
  const refused = await health.checkSite(site, { fetchImpl: async (u) => slowBody(u), render: browserThrows("page.goto: net::ERR_CONNECTION_REFUSED at https://gone.example/") });
  assert.equal(refused.ok, false, refused.reason);
});

test("review 2: a removed site comes back only by passing the same full check, and only when it was removed for not answering", async () => {
  const now = new Date("2026-12-30T00:00:00Z");
  const removed = "2026-11-16";
  const list = [
    { url: "https://blank.example", name: "Ann Lee", kind: "down", reason: "renders blank", removed },
    { url: "https://gated.example", name: "Ann Lee", kind: "down", reason: "capture blocked: still a gate or loader after the click-through", removed },
    { url: "https://linked.example", name: "Ann Lee", kind: "down", reason: "redirects to linkedin.com, not a portfolio", removed },
    { url: "https://parked.example", name: "Ann Lee", kind: "down", reason: "HTTP 402: deployment paused", removed },
    { url: "https://empty.example", name: "Ann Lee", kind: "down", reason: "HTTP 500", removed },
    { url: "https://back.example", name: "Ann Lee", kind: "down", reason: "does not load (connect timeout (nothing answers at the address))", removed },
  ];
  const pages = {
    "https://blank.example": "<div id=root></div>",
    "https://gated.example": PORTFOLIO_HTML,
    "https://linked.example": PORTFOLIO_HTML,
    // Answers 200 now, but with a parking page: not back.
    "https://parked.example": "<html><head><title>This domain is for sale</title></head><body>Buy this domain</body></html>",
    // Answers 200 now, but blank in the browser too: not back.
    "https://empty.example": "<div id=root></div>",
    "https://back.example": PORTFOLIO_HTML,
  };
  const checked = [];
  const fetchImpl = async (u) => (checked.push(u.replace(/\/$/, "")), response(200, pages[u.replace(/\/$/, "")] ?? "", u));
  const render = async (u) => ({ status: 200, finalUrl: u, title: "", text: "", media: false, html: "" });
  const r = await exclusions.planDeadRecheck({ excluded: list, now, answers: exclusions.passesFullCheck({ render, fetchImpl }) });
  assert.deepEqual(r.back, ["https://back.example"]);
  assert.deepEqual(r.still.sort(), ["https://empty.example", "https://parked.example"]);
  for (const u of ["https://blank.example", "https://gated.example", "https://linked.example"]) assert.ok(!checked.includes(u), `${u} is never re-checked`);
});

test("review 3: failures count a week after the last counted one, not on a ladder from the first", async () => {
  const { db } = await freshDb();
  const url = "https://flaky.example";
  await site(db, url);
  const feed = [{ url, name: "Ann Lee" }, ...filler];
  // A page that answers blank: the weekly-counted ladder (a site that does not answer has the not-working pool's).
  const fail = async (u) => (u.startsWith(url) ? response(200, "<div id=root></div>", u) : response(200, PORTFOLIO_HTML, u));
  const unsure = async (u) => (u.startsWith(url) ? slowBody(u) : response(200, PORTFOLIO_HTML, u));
  const render = async (u) => (u.startsWith(url) ? { status: 200, finalUrl: `${url}/`, title: "", text: "", media: false, html: "" } : goodPage(u));
  const blindRender = async (u) => {
    if (u.startsWith(url)) throw new Error("page.goto: Timeout 30000ms exceeded.");
    return goodPage(u);
  };
  await health.runHealthCheck({ db, feed, fetchImpl: fail, render, now: at(0), log: quiet });
  await health.runHealthCheck({ db, feed, fetchImpl: unsure, render: blindRender, now: at(7), log: quiet });
  await health.runHealthCheck({ db, feed, fetchImpl: fail, render, now: at(14), log: quiet });
  // A manual re-run an hour later, on the same bad day.
  await health.runHealthCheck({ db, feed, fetchImpl: fail, render, now: new Date(at(14).getTime() + 3600000), log: quiet });
  assert.deepEqual([await col(db, url, "health"), Number(await col(db, url, "health_fails"))], ["suspect", 2]);
});

test("review 4: a browser that cannot start or a tab that crashes is never held against a site; a browser that never starts fails the run", async () => {
  const spa = async (u) => response(200, "<div id=root></div><script src=app.js></script>", u);
  const site1 = { url: "https://spa.example", name: "Ann Lee" };
  for (const message of ["browserType.launch: Executable doesn't exist at /ms-playwright/chromium-1254/chrome-linux/chrome", "page.goto: Page crashed", "page.goto: Target crashed"]) {
    const r = await health.checkSite(site1, { fetchImpl: spa, render: browserThrows(message) });
    assert.equal(r.ok, null, `${message}: ${r.reason}`);
  }
  const unavailable = await health.checkSite(site1, {
    fetchImpl: spa,
    render: async () => {
      throw new render.BrowserUnavailableError(new Error("spawn ENOENT"));
    },
  });
  assert.equal(unavailable.ok, null);
  // A failed launch is not kept: the next render launches again.
  let launches = 0;
  const fakeBrowser = {
    version: () => "158.0.8127.18",
    newContext: async () => ({
      newPage: async () => ({
        goto: async () => ({ status: () => 200 }),
        waitForLoadState: async () => {},
        waitForTimeout: async () => {},
        url: () => "https://spa.example/",
        title: async () => "Ann Lee",
        evaluate: async () => ({ text: "Ann Lee builds web apps.", media: false, html: "" }),
      }),
      close: async () => {},
    }),
    close: async () => {},
  };
  const renderer = render.createRenderer({
    launch: async () => {
      launches++;
      if (launches === 1) throw new Error("browserType.launch: Executable doesn't exist");
      return fakeBrowser;
    },
  });
  await assert.rejects(renderer.render("https://spa.example"), (e) => e.name === "BrowserUnavailableError");
  assert.equal((await renderer.render("https://spa.example")).status, 200);
  assert.equal(launches, 2);
  // Every render failing to launch: the run records nothing and fails.
  const { db } = await freshDb();
  const feed = [{ url: site1.url, name: "Ann Lee" }, ...filler];
  const s = await health.runHealthCheck({ db, feed, fetchImpl: spa, render: browserThrows("browserType.launch: Executable doesn't exist"), now: at(0), log: quiet });
  assert.equal(s.aborted, true);
  assert.match(s.message, /browser could not start/);
  assert.equal(await col(db, site1.url, "health_checked_at"), undefined, "nothing recorded (no row written)");
});

test("review 5: a runner that could not tell for most sites fails the run; a site unknown for four weeks of nightly runs goes to the owner", async () => {
  const { db } = await freshDb();
  const feed = filler.slice(0, 25);
  const s = await health.runHealthCheck({ db, feed, fetchImpl: async (u) => slowBody(u), render: browserThrows("page.goto: Timeout 30000ms exceeded."), now: at(0), log: quiet });
  assert.equal(s.aborted, true);
  assert.match(s.message, /could not tell/);

  const url = "https://always-unsure.example";
  await site(db, url);
  const mixed = [{ url, name: "Ann Lee" }, ...filler];
  const fetchImpl = async (u) => (u.startsWith(url) ? slowBody(u) : response(200, PORTFOLIO_HTML, u));
  const browser = async (u) => {
    if (u.startsWith(url)) throw new Error("page.goto: Timeout 30000ms exceeded.");
    return goodPage(u);
  };
  // The full check runs every night: four runs are not four weeks; 28 days are.
  let last;
  for (let d = 0; d < health.UNKNOWN_DAYS_TO_OWNER; d++) {
    last = await health.runHealthCheck({ db, feed: mixed, fetchImpl, render: browser, now: at(d), log: quiet });
    assert.deepEqual(last.unknownForWeeks, [], `no alert on day ${d}`);
  }
  last = await health.runHealthCheck({ db, feed: mixed, fetchImpl, render: browser, now: at(health.UNKNOWN_DAYS_TO_OWNER), log: quiet });
  assert.deepEqual(last.unknownForWeeks?.map((u) => u.url), [url]);
  const alert = (await db.execute({ sql: "SELECT title, detail FROM owner_alerts WHERE key = ? AND cleared_at IS NULL", args: [health.UNKNOWN_ALERT_KEY] })).rows[0];
  assert.ok(alert && String(alert.detail).includes(url), "an alert on /admin/alerts names the site");
  // It answers again: the alert clears.
  await health.runHealthCheck({ db, feed: mixed, fetchImpl: async (u) => response(200, PORTFOLIO_HTML, u), render: async (u) => goodPage(u), now: at(health.UNKNOWN_DAYS_TO_OWNER + 1), log: quiet });
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS n FROM owner_alerts WHERE key = ? AND cleared_at IS NULL", args: [health.UNKNOWN_ALERT_KEY] })).rows[0].n, 0);
});

test("review 9: 'a removal is on record' has one definition, built from the review queue's own APPLIED list", () => {
  const root = path.join(import.meta.dirname, "..");
  for (const file of ["pipeline/health.mjs", "pipeline/exclusions.mjs"]) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    assert.ok(!/'confirmed',\s*'auto_applied'/.test(src), `${file} hard-codes the applied statuses`);
    assert.ok(!/proposed = 'remove' AND d?\.?status IN/.test(src.replace(/APPLIED_REMOVAL_WHERE[\s\S]*?;\n/, "")), `${file} writes the rule a second time`);
  }
  assert.match(health.APPLIED_REMOVAL_WHERE(), /status IN \('confirmed', 'auto_applied'\)/);
});

test("review 10: the pages the health check calls a bot wall (the capture's rule), pinned", () => {
  const walls = [
    { title: "Just a moment...", text: "Checking if the site connection is secure" },
    { title: "Vercel Security Checkpoint", text: "We're verifying your browser" },
    { title: "", text: "Verifying you are human. This may take a few seconds." },
    { title: "Attention Required! | Cloudflare", text: "Please enable cookies." },
    { title: "Verifying you are human", text: "" },
  ];
  const notWalls = [
    { title: "Ann Lee | Engineer", text: `Ann Lee builds web apps. ${"Projects, about and contact. ".repeat(30)}` },
    { title: "", text: "" },
    { title: "Ann Lee", text: "Enter" },
    // A long portfolio page that mentions a security check in passing.
    { title: "Ann Lee | Security engineer", text: `I build bot detection. Just a moment... is what Cloudflare shows. ${"I write about web security and performance. ".repeat(30)}` },
  ];
  for (const p of walls) assert.equal(health.isBotWallPage(p), true, JSON.stringify(p));
  for (const p of notWalls) assert.equal(health.isBotWallPage(p), false, JSON.stringify(p));
});

test("review: the summary lists under the review queue only grades that got a review row", async () => {
  const { db } = await freshDb();
  const url = "https://owner-kept.example";
  await site(db, url, { rubric: legacyGrade, n: 1 });
  // The owner confirmed it is a portfolio long ago (a relist he confirmed): the door follows him and writes no row.
  await ensureReviewSchema(db);
  await db.execute({
    sql: `INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, reason, off_list, verdicts, signals, status, created_at, decided_at, decided_by)
          VALUES ('old', ?, 'not_portfolio', 'hidden', 'relist', 0, 'old', 0, '{}', '{}', 'confirmed', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'admin:owner')`,
    args: [url],
  });
  const s = await health.runHealthCheck({ db, feed: [{ url, name: "Ann Lee" }, ...filler], fetchImpl: async (u) => response(200, PORTFOLIO_HTML, u), now: at(0), log: quiet });
  assert.deepEqual(s.toOwnerReview, []);
  assert.deepEqual(s.settledAtDoor?.map((d) => [d.url, d.outcome]), [[url, "owner"]]);
  assert.doesNotMatch(health.healthSummary(s), /sent to the review queue[\s\S]*owner-kept/);
});
