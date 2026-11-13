// The blog newsletter on a throwaway database with Kit mocked
// (lib/newsletter): the Kit client's calls, one broadcast per published post
// (scheduled or a draft, never twice), the fallbacks when Kit refuses, and
// the email itself. Nothing here holds an address.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { KitError, kitClient } from "../lib/newsletter/kit.mjs";
import { CREATING_STUCK_MS, cleanSource, recentIssues } from "../lib/newsletter/store.mjs";
import { SEND_DELAY_MS, broadcastMode, newsletterTick } from "../lib/newsletter/send.mjs";
import { KIT_ADDRESS, KIT_UNSUBSCRIBE, postEmail } from "../lib/newsletter/emails.mjs";

const BASE = "https://portfoliorank.example";
const T0 = Date.UTC(2026, 10, 12, 18);
const HOUR = 3_600_000;

async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "newsletter-"));
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(db);
  return db;
}

async function addPost(db, { id = "p1", publishAt = T0, status = "published", pending = 1 } = {}) {
  await db.execute({
    sql: `INSERT INTO posts (id, slug, kind, status, mode, title, subtitle, newsletter_blurb, ai_line, ai_note, body, facts, checks, images, claims, data_as_of, publish_at, newsletter_pending, created_at, updated_at)
          VALUES (?, ?, 'trend', ?, 'dry-run', ?, 'Sub', 'What the top portfolios share.', 'AI', 'note', 'body', '{}', '{}', ?, '[]', '2026-11-10', ?, ?, ?, ?)`,
    args: [id, `post-${id}`, status, `Title ${id}`, JSON.stringify([{ slot: "hero", kind: "chart" }]), new Date(publishAt).toISOString(), pending, new Date(T0).toISOString(), new Date(T0).toISOString()],
  });
}

/** A mocked Kit API behind fetch: records every call; `answer` can override a response. */
function mockKit({ answer = () => null } = {}) {
  const calls = [];
  let nextId = 100;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    const call = { method: init.method ?? "GET", path: u.pathname.replace(/^\/v4/, ""), query: Object.fromEntries(u.searchParams), body, key: init.headers?.["X-Kit-Api-Key"] };
    calls.push(call);
    const over = answer(call);
    const [status, data] =
      over ??
      (call.path === "/subscribers" && call.method === "POST"
        ? [201, { subscriber: { id: 1, email_address: body.email_address, state: body.state } }]
        : /^\/forms\/\d+\/subscribers$/.test(call.path)
          ? [201, { subscriber: { id: 1, state: "inactive" } }]
          : call.path === "/forms"
            ? [200, { forms: [{ id: 42, name: "Blog" }], pagination: {} }]
            : call.path === "/subscribers"
              ? [200, { subscribers: [], pagination: { has_next_page: false, total_count: 7 } }]
              : call.path === "/broadcasts"
                ? [201, { broadcast: { id: nextId++, send_at: body.send_at } }]
                : [404, { errors: ["Not Found"] }]);
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, kit: kitClient({ apiKey: "test-key", base: "https://kit.test/v4", fetch }) };
}

test("the Kit client: no key, no client; sign-up is an unconfirmed subscriber added to the double opt-in form", async () => {
  assert.equal(kitClient({ apiKey: "" }), null);
  assert.equal(kitClient({}), null);
  const { calls, kit } = mockKit();
  await kit.subscribe("ada@example.com", { formId: "42", referrer: `${BASE}/blog/x` });
  assert.deepEqual(
    calls.map((c) => [c.method, c.path, c.body]),
    [
      ["POST", "/subscribers", { email_address: "ada@example.com", state: "inactive" }],
      ["POST", "/forms/42/subscribers", { email_address: "ada@example.com", referrer: `${BASE}/blog/x` }],
    ]
  );
  assert.ok(calls.every((c) => c.key === "test-key"));
  await assert.rejects(kit.subscribe("a@example.com", { formId: "" }), /form id/);
  assert.equal(await kit.confirmedCount(), 7);
  assert.deepEqual(calls.at(-1).query, { status: "active", include_total_count: "true", per_page: "1" });
  assert.equal(await kit.onlyForm(), "42");
});

test("the Kit client: errors carry the status and never the address", async () => {
  const { kit } = mockKit({ answer: (c) => (c.path === "/subscribers" ? [422, { errors: ["Email address bob@example.com is invalid"] }] : null) });
  const e = await kit.subscribe("bob@example.com", { formId: 1 }).catch((x) => x);
  assert.ok(e instanceof KitError);
  assert.equal(e.status, 422);
  assert.ok(!e.message.includes("bob@example.com"), e.message);
  const two = mockKit({ answer: (c) => (c.path === "/forms" ? [200, { forms: [{ id: 1 }, { id: 2 }] }] : null) });
  assert.equal(await two.kit.onlyForm(), null, "several forms: KIT_FORM_ID must say which");
});

test("a published post becomes one scheduled broadcast in send mode, once", async () => {
  const db = await freshDb();
  await addPost(db);
  const { calls, kit } = mockKit();
  const notes = [];
  const t1 = await newsletterTick({ db, kit, mode: "send", base: BASE, now: T0 + HOUR, notify: async (l) => notes.push(l) });
  assert.deepEqual(t1, { queued: 1, scheduled: 1, drafts: 0, stopped: 0, waiting: null });
  const b = calls.find((c) => c.path === "/broadcasts");
  assert.equal(b.body.send_at, new Date(T0 + HOUR + SEND_DELAY_MS).toISOString());
  assert.equal(b.body.subject, "Title p1");
  assert.equal(b.body.public, false);
  assert.equal(b.body.subscriber_filter, undefined, "no filter: every subscriber");
  assert.ok(b.body.content.includes(`${BASE}/blog/post-p1`));
  assert.ok(b.body.content.includes(KIT_UNSUBSCRIBE) && b.body.content.includes(KIT_ADDRESS), "Kit's unsubscribe link and address");
  assert.equal(b.body.thumbnail_url, `${BASE}/blog/media/p1/hero`);
  assert.deepEqual(notes, [], "a scheduled send needs no note");

  const t2 = await newsletterTick({ db, kit, mode: "send", base: BASE, now: T0 + 2 * HOUR });
  assert.deepEqual(t2, { queued: 0, scheduled: 0, drafts: 0, stopped: 0, waiting: null });
  assert.equal(calls.filter((c) => c.path === "/broadcasts").length, 1, "never twice");
  const [issue] = await recentIssues(db);
  assert.equal(issue.status, "scheduled");
  assert.equal(issue.broadcastId, "100");
  assert.equal(issue.sendAt, new Date(T0 + HOUR + SEND_DELAY_MS).toISOString());
  assert.equal(Number((await db.execute("SELECT newsletter_pending FROM posts")).rows[0].newsletter_pending), 0);
});

test("draft mode (and staging) saves a draft and sends the owner a one-line note", async () => {
  const db = await freshDb();
  await addPost(db);
  const { calls, kit } = mockKit();
  const notes = [];
  const t = await newsletterTick({ db, kit, mode: "draft", label: "staging", base: BASE, now: T0 + HOUR, notify: async (l) => notes.push(l) });
  assert.equal(t.drafts, 1);
  const b = calls.find((c) => c.path === "/broadcasts");
  assert.equal(b.body.send_at, null);
  assert.equal(b.body.subject, "[staging] Title p1");
  assert.deepEqual(notes, ['[staging] Newsletter: draft ready in Kit for "Title p1".']);
  assert.equal((await recentIssues(db))[0].status, "draft");
  assert.equal(broadcastMode("send"), "send");
  assert.equal(broadcastMode(undefined), "draft");
  assert.equal(broadcastMode("SEND "), "send");
  assert.equal(broadcastMode("yes"), "draft");
});

test("Kit refuses to schedule (403): the same post is saved as a draft instead, with the note", async () => {
  const db = await freshDb();
  await addPost(db);
  const { calls, kit } = mockKit({ answer: (c) => (c.path === "/broadcasts" && c.body.send_at ? [403, { errors: ["Upgrade to schedule"] }] : null) });
  const notes = [];
  const t = await newsletterTick({ db, kit, mode: "send", base: BASE, now: T0 + HOUR, notify: async (l) => notes.push(l) });
  assert.equal(t.drafts, 1);
  assert.equal(t.scheduled, 0);
  assert.deepEqual(calls.filter((c) => c.path === "/broadcasts").map((c) => c.body.send_at === null), [false, true]);
  const [issue] = await recentIssues(db);
  assert.equal(issue.status, "draft");
  assert.match(issue.reason, /Kit refused to schedule it .*403.*saved as a draft/);
  assert.equal(notes.length, 1);
});

test("Kit busy (429) waits for the next tick; any other failure stops the post with a note to check Kit", async () => {
  const db = await freshDb();
  await addPost(db, { id: "a" });
  let busy = true;
  const { calls, kit } = mockKit({ answer: (c) => (c.path === "/broadcasts" && busy ? [429, { errors: ["Too many requests"] }] : null) });
  const t1 = await newsletterTick({ db, kit, mode: "send", base: BASE, now: T0 + HOUR });
  assert.equal(t1.scheduled, 0);
  assert.equal((await recentIssues(db))[0].status, "queued");
  busy = false;
  const t2 = await newsletterTick({ db, kit, mode: "send", base: BASE, now: T0 + HOUR + 600_000 });
  assert.equal(t2.scheduled, 1);

  await addPost(db, { id: "b" });
  const broken = mockKit({ answer: (c) => (c.path === "/broadcasts" ? [500, { errors: ["Internal error"] }] : null) });
  const t3 = await newsletterTick({ db, kit: broken.kit, mode: "send", base: BASE, now: T0 + 2 * HOUR });
  assert.equal(t3.stopped, 1);
  const b = (await recentIssues(db)).find((i) => i.postId === "b");
  assert.equal(b.status, "stopped");
  assert.match(b.reason, /500.*check Kit/);
  await newsletterTick({ db, kit: broken.kit, mode: "send", base: BASE, now: T0 + 3 * HOUR });
  assert.equal(broken.calls.filter((c) => c.path === "/broadcasts").length, 1, "a stopped post is never retried");
  assert.equal(calls.filter((c) => c.path === "/broadcasts").length, 2);
});

test("a Kit call that never reported back is stopped after an hour, never retried", async () => {
  const db = await freshDb();
  await addPost(db);
  await newsletterTick({ db, kit: null, base: BASE, now: T0 + HOUR });
  // As if a tick claimed the issue and died during the Kit call.
  await db.execute({ sql: "UPDATE newsletter_issues SET status = 'creating', finished_at = ?", args: [new Date(T0 + HOUR).toISOString()] });
  const { calls, kit } = mockKit();
  assert.equal((await newsletterTick({ db, kit, mode: "send", base: BASE, now: T0 + HOUR + 600_000 })).stopped, 0, "not yet");
  const t = await newsletterTick({ db, kit, mode: "send", base: BASE, now: T0 + HOUR + CREATING_STUCK_MS });
  assert.equal(t.stopped, 1);
  assert.match((await recentIssues(db))[0].reason, /check Kit/);
  assert.equal(calls.length, 0);
});

test("no Kit key, old posts and unpublished posts make no broadcast", async () => {
  const db = await freshDb();
  await addPost(db, { id: "old", publishAt: T0 - 5 * 24 * HOUR });
  await addPost(db, { id: "later", publishAt: T0 + 24 * HOUR });
  await addPost(db, { id: "now", publishAt: T0 });
  const t = await newsletterTick({ db, kit: null, base: BASE, now: T0 + HOUR });
  assert.deepEqual(t, { queued: 2, scheduled: 0, drafts: 0, stopped: 0, waiting: "no_kit_key" });
  const issues = await recentIssues(db);
  assert.deepEqual(issues.map((i) => [i.postId, i.status]).sort(), [["now", "queued"], ["old", "skipped"]], "a backlog is never mailed; a future post waits");

  await db.execute("UPDATE posts SET status = 'unpublished' WHERE id = 'now'");
  const { calls, kit } = mockKit();
  await newsletterTick({ db, kit, mode: "send", base: BASE, now: T0 + 2 * HOUR });
  assert.equal(calls.length, 0);
  assert.equal((await recentIssues(db)).find((i) => i.postId === "now").status, "stopped");
});

test("the database keeps no subscriber or address tables", async () => {
  const db = await freshDb();
  const tables = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'newsletter%'")).rows.map((r) => String(r.name));
  assert.deepEqual(tables, ["newsletter_issues"]);

  // A database from the self-sent version (staging): its address tables go, its issues gain Kit's columns.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "newsletter-old-"));
  const old = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await old.batch(
    [
      "CREATE TABLE newsletter_subscribers (id TEXT PRIMARY KEY, email TEXT NOT NULL, email_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL)",
      "INSERT INTO newsletter_subscribers VALUES ('s1', 'ada@example.com', 'h', 'confirmed')",
      "CREATE TABLE newsletter_deliveries (issue_id TEXT NOT NULL, subscriber_id TEXT NOT NULL, status TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (issue_id, subscriber_id))",
      "CREATE TABLE newsletter_issues (id TEXT PRIMARY KEY, post_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL, finished_at TEXT)",
      "INSERT INTO newsletter_issues VALUES ('i1', 'p0', 'sent', NULL, '2026-11-10T00:00:00.000Z', '2026-11-10T00:10:00.000Z')",
    ],
    "write"
  );
  await migrate(old);
  const left = (await old.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'newsletter%'")).rows.map((r) => String(r.name));
  assert.deepEqual(left, ["newsletter_issues"]);
  const [issue] = await recentIssues(old);
  assert.equal(issue.status, "sent");
  assert.equal(issue.broadcastId, null);
});

test("sources are same-site paths and a known form, never a full URL", () => {
  assert.equal(cleanSource("/blog/x?utm=1", "sidebar"), "/blog/x (sidebar)");
  assert.equal(cleanSource("https://evil.example/x", "footer"), "? (footer)");
  assert.equal(cleanSource("//evil.example", "nope"), null);
});

test("the email: everything is escaped, Kit's tags go in as they are, no em dashes", () => {
  const p = postEmail({ title: "A <b> & c", summary: "x", url: `${BASE}/blog/a`, site: BASE });
  assert.ok(p.html.includes("A &lt;b&gt; &amp; c") && !p.html.includes("<b>"));
  assert.equal(p.subject, "A <b> & c");
  assert.equal(p.previewText, "x");
  assert.ok(p.html.includes(`href="${KIT_UNSUBSCRIBE}"`));
  assert.ok(!p.html.includes("—"));
  const preview = postEmail({ title: "T", summary: null, url: "u", site: BASE, unsubscribeUrl: "#", address: "addr" });
  assert.ok(!preview.html.includes("{{") && preview.previewText === "T");
});
