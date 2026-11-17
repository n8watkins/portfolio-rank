// The 2026-11-16 audit of the weekly health check (pipeline/health.mjs,
// pipeline/gate.mjs, pipeline/render.mjs, pipeline/exclusions.mjs): it took
// live sites off the list by mistake. One test or more per finding, each
// written to fail on the code before the fix. Offline: fetch and the browser
// are stand-ins, the database is a throwaway local file.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as gate from "../pipeline/gate.mjs";
import * as health from "../pipeline/health.mjs";
import * as exclusions from "../pipeline/exclusions.mjs";
import * as render from "../pipeline/render.mjs";
import { BOT_WALL_REASON } from "../pipeline/capture-blocked.mjs";
import { autoApplyReviews, undoReviews } from "../lib/reviews/store.mjs";
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

test("a: the plain request sends a browser's navigation headers; a host that answers 500 without them passes", async () => {
  // juanbenito.vercel.app (2026-11-16): HTTP 500 "Internal Server Error" (21 bytes) to a request with only a User-Agent.
  const fetchImpl = async (u, init) => (headerOf(init, "sec-fetch-mode") === "navigate" && /text\/html/.test(headerOf(init, "accept")) ? response(200, PORTFOLIO_HTML, u) : response(500, "Internal Server Error", u));
  const g = await gate.httpGate("https://juanbenito.example", { fetchImpl });
  assert.equal(g.status, "live", g.reason);
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
  const s = await health.runHealthCheck({ db: racing, feed, fetchImpl: async (u) => (u.startsWith(url) ? response(500, "Internal Server Error", u) : response(200, PORTFOLIO_HTML, u)), render, now: at(7), concurrency: 1, log: quiet });
  assert.ok(raced);
  assert.equal(await col(db, url, "health"), "live");
  assert.ok(s.changedDuringRun?.includes(url), "reported, for next week's check");
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
  const fail = { ok: false, reason: "HTTP 500" };
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
  assert.equal(await exclusions.siteAnswers("https://paused.example", { fetchImpl: async (u) => response(200, `<p>This deployment is temporarily paused</p>${" ".repeat(300)}`, u) }), false);
});
