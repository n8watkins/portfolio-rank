// The blog newsletter's store and sender (lib/newsletter) on a throwaway
// database: double opt-in, unsubscribe links, retention, issues per post,
// paced batches, the caps (which fail closed) and the emails themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { createEmailGate, emailTransport } from "../lib/email/gate.mjs";
import {
  CONFIRM_TTL_MS,
  PENDING_KEEP_MS,
  UNSUBSCRIBED_KEEP_MS,
  cleanSource,
  confirmSubscription,
  listSubscribers,
  newsletterCounts,
  peekConfirm,
  pruneNewsletter,
  recentIssues,
  subscribe,
  unsubKey,
  unsubscribe,
} from "../lib/newsletter/store.mjs";
import { newsletterTick, unsubscribeUrl } from "../lib/newsletter/send.mjs";
import { confirmEmail, postEmail } from "../lib/newsletter/emails.mjs";

const SECRET = "test-secret";
const BASE = "https://portfoliorank.example";
const T0 = Date.UTC(2026, 10, 12, 18);
const HOUR = 3_600_000;

async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "newsletter-"));
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(db);
  return db;
}

async function confirmed(db, email, now = T0) {
  const s = await subscribe(db, { email, source: "/blog (blog)", now, secret: SECRET });
  await confirmSubscription(db, s.token, { now });
  return s.id;
}

async function addPost(db, { id = "p1", publishAt = T0, status = "published", pending = 1 } = {}) {
  await db.execute({
    sql: `INSERT INTO posts (id, slug, kind, status, mode, title, subtitle, newsletter_blurb, ai_line, ai_note, body, facts, checks, images, claims, data_as_of, publish_at, newsletter_pending, created_at, updated_at)
          VALUES (?, ?, 'trend', ?, 'dry-run', ?, 'Sub', 'What the top portfolios share.', 'AI', 'note', 'body', '{}', '{}', ?, '[]', '2026-11-10', ?, ?, ?, ?)`,
    args: [id, `post-${id}`, status, `Title ${id}`, JSON.stringify([{ slot: "hero", kind: "chart" }]), new Date(publishAt).toISOString(), pending, new Date(T0).toISOString(), new Date(T0).toISOString()],
  });
}

/** A gate over a fake mailroom that records what it sent and can refuse. */
function fakeGate(db, { refuse = () => null, caps } = {}) {
  const sent = [];
  const env = {
    MAILROOM_NEWS: {
      async send(m) {
        const code = refuse(m);
        if (code) return { ok: false, code, retryable: false, message: code };
        sent.push(m);
        return { ok: true, messageId: `m${sent.length}` };
      },
    },
  };
  const gate = createEmailGate({ db, transport: emailTransport(env, { via: "mailroom-news" }), secret: SECRET, now: () => new Date(T0), ...(caps ? { caps } : {}) });
  return { gate, sent };
}

test("double opt-in: pending until the link is used, once, within 3 days", async () => {
  const db = await freshDb();
  const a = await subscribe(db, { email: "ada@example.com", source: "/blog/x (sidebar)", now: T0, secret: SECRET });
  assert.equal(a.action, "confirm");
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await newsletterCounts(db), { confirmed: 0, pending: 1, unsubscribed: 0 });
  assert.deepEqual(await peekConfirm(db, a.token, { now: T0 }), { email: "ada@example.com" });

  // Signing up again sends a new link; the old one stops working.
  const again = await subscribe(db, { email: "ada@example.com", now: T0 + 1000, secret: SECRET });
  assert.equal(again.id, a.id, "one row per address");
  assert.deepEqual(await confirmSubscription(db, a.token, { now: T0 + 2000 }), { error: "invalid" });
  assert.deepEqual(await confirmSubscription(db, again.token, { now: T0 + 2000 }), { ok: true, email: "ada@example.com" });
  assert.deepEqual(await confirmSubscription(db, again.token, { now: T0 + 3000 }), { error: "invalid" }, "a link works once");
  assert.deepEqual(await newsletterCounts(db), { confirmed: 1, pending: 0, unsubscribed: 0 });

  // A confirmed address signing up again gets no email and stays confirmed.
  assert.equal((await subscribe(db, { email: "ada@example.com", now: T0 + 4000, secret: SECRET })).action, "none");
  const [row] = await listSubscribers(db);
  assert.equal(row.status, "confirmed");
  assert.equal(row.source, "/blog/x (sidebar)", "the page it signed up on is kept");

  const late = await subscribe(db, { email: "bob@example.com", now: T0, secret: SECRET });
  assert.deepEqual(await confirmSubscription(db, late.token, { now: T0 + CONFIRM_TTL_MS + 1 }), { error: "expired" });
  assert.deepEqual(await confirmSubscription(db, "nope", { now: T0 }), { error: "invalid" });
});

test("unsubscribe links work only with their key, and retention deletes what it should", async () => {
  const db = await freshDb();
  const id = await confirmed(db, "ada@example.com");
  assert.deepEqual(await unsubscribe(db, { id, key: "x".repeat(32), secret: SECRET, now: T0 }), { error: "invalid" });
  assert.deepEqual(await unsubscribe(db, { id, key: unsubKey(id, "another-secret"), secret: SECRET, now: T0 }), { error: "invalid" });
  assert.deepEqual(await unsubscribe(db, { id, key: unsubKey(id, SECRET), secret: SECRET, now: T0 + HOUR }), { ok: true });
  assert.deepEqual(await unsubscribe(db, { id, key: unsubKey(id, SECRET), secret: SECRET, now: T0 + 2 * HOUR }), { ok: true }, "twice is fine");
  assert.deepEqual(await newsletterCounts(db), { confirmed: 0, pending: 0, unsubscribed: 1 });
  assert.equal((await listSubscribers(db))[0].unsubscribedAt, new Date(T0 + HOUR).toISOString(), "the first unsubscribe time is kept");

  await subscribe(db, { email: "never@example.com", now: T0, secret: SECRET });
  await confirmed(db, "stays@example.com");
  assert.equal(await pruneNewsletter(db, { now: T0 + PENDING_KEEP_MS + 1 }), 1, "the unconfirmed sign-up goes after 7 days");
  assert.equal(await pruneNewsletter(db, { now: T0 + HOUR + UNSUBSCRIBED_KEEP_MS + 1 }), 1, "the unsubscribed address goes 30 days later");
  assert.deepEqual((await listSubscribers(db)).map((s) => s.email), ["stays@example.com"]);

  // Signing up again after unsubscribing starts over at pending.
  const id2 = await confirmed(db, "back@example.com");
  await unsubscribe(db, { id: id2, key: unsubKey(id2, SECRET), secret: SECRET, now: T0 });
  const back = await subscribe(db, { email: "back@example.com", now: T0 + HOUR, secret: SECRET });
  assert.equal(back.action, "confirm");
  assert.equal((await listSubscribers(db)).find((s) => s.email === "back@example.com").status, "pending");
});

test("sources are same-site paths and a known form, never a full URL", () => {
  assert.equal(cleanSource("/blog/x?utm=1", "sidebar"), "/blog/x (sidebar)");
  assert.equal(cleanSource("https://evil.example/", "footer"), "? (footer)");
  assert.equal(cleanSource("//evil", "nope"), null);
  assert.equal(cleanSource("/blog", undefined), "/blog");
});

test("a published post goes to confirmed subscribers only, in paced batches, once each", async () => {
  const db = await freshDb();
  const ids = [];
  for (let i = 0; i < 13; i++) ids.push(await confirmed(db, `r${i}@example.com`));
  await subscribe(db, { email: "pending@example.com", now: T0, secret: SECRET });
  const gone = await confirmed(db, "gone@example.com");
  await unsubscribe(db, { id: gone, key: unsubKey(gone, SECRET), secret: SECRET, now: T0 });
  await addPost(db, { publishAt: T0 });
  const { gate, sent } = fakeGate(db);

  const t1 = await newsletterTick({ db, gate, base: BASE, secret: SECRET, now: T0 + HOUR, batch: 10 });
  assert.deepEqual(t1, { queued: 1, sent: 10, failed: 0, stopped: null });
  assert.equal(Number((await db.execute("SELECT newsletter_pending FROM posts")).rows[0].newsletter_pending), 0);
  const t2 = await newsletterTick({ db, gate, base: BASE, secret: SECRET, now: T0 + HOUR + 600_000, batch: 10 });
  assert.deepEqual(t2, { queued: 0, sent: 3, failed: 0, stopped: null });
  const t3 = await newsletterTick({ db, gate, base: BASE, secret: SECRET, now: T0 + HOUR + 1_200_000, batch: 10 });
  assert.deepEqual(t3, { queued: 0, sent: 0, failed: 0, stopped: null });
  assert.equal(sent.length, 13);
  assert.equal(new Set(sent.map((m) => m.to)).size, 13, "nobody twice");
  assert.ok(!sent.some((m) => m.to === "pending@example.com" || m.to === "gone@example.com"));
  const [issue] = await recentIssues(db);
  assert.equal(issue.status, "sent");
  assert.equal(issue.sent, 13);

  // Each email: the mailroom kind, an idempotency key, one-click unsubscribe headers and link.
  const m = sent.find((x) => x.to === "r0@example.com");
  assert.equal(m.kind, "post");
  assert.match(m.key, /^nl-[0-9a-f]{16}-[A-Za-z0-9_-]{16}$/);
  const url = unsubscribeUrl(BASE, ids[0], SECRET);
  assert.equal(m.headers["List-Unsubscribe"], `<${url}>`);
  assert.equal(m.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.ok(m.text.includes(url) && m.html.includes(url.replace(/&/g, "&amp;")));
  assert.ok(m.text.includes(`${BASE}/blog/post-p1`));
  assert.ok(m.html.includes(`${BASE}/blog/media/p1/hero`), "the cover image is an absolute URL");
});

test("caps fail closed: a full day stops the batch and the rest waits", async () => {
  const db = await freshDb();
  for (let i = 0; i < 6; i++) await confirmed(db, `r${i}@example.com`);
  await addPost(db, { publishAt: T0 });
  const caps = { day: 100, perRecipient: 3, perRecipientByKind: { newsletter: 3 }, kinds: { newsletter: 4 }, reserve: {} };
  const { gate, sent } = fakeGate(db, { caps });
  const t = await newsletterTick({ db, gate, base: BASE, secret: SECRET, now: T0 + HOUR, batch: 10 });
  assert.equal(t.sent, 4);
  assert.equal(t.stopped, "cap:kind");
  assert.equal(sent.length, 4);
  const [issue] = await recentIssues(db);
  assert.equal(issue.status, "sending");
  assert.equal(issue.waiting, 2, "the other two wait for a later day");
});

test("mailroom refusals: one address is skipped, anything else stops the tick", async () => {
  const db = await freshDb();
  for (let i = 0; i < 3; i++) await confirmed(db, `r${i}@example.com`);
  await addPost(db, { publishAt: T0 });
  let mode = "suppress-one";
  const { gate, sent } = fakeGate(db, {
    refuse: (m) => (mode === "suppress-one" && m.to === "r1@example.com" ? "suppressed" : mode === "month" ? "cap_app_month" : null),
  });
  mode = "month";
  const stopped = await newsletterTick({ db, gate, base: BASE, secret: SECRET, now: T0 + HOUR });
  assert.equal(stopped.sent, 0);
  assert.match(stopped.stopped, /cap_app_month/);
  mode = "suppress-one";
  const t = await newsletterTick({ db, gate, base: BASE, secret: SECRET, now: T0 + 2 * HOUR });
  assert.deepEqual({ sent: t.sent, failed: t.failed, stopped: t.stopped }, { sent: 2, failed: 1, stopped: null });
  assert.deepEqual(sent.map((m) => m.to).sort(), ["r0@example.com", "r2@example.com"]);
});

test("no transport, old posts and unpublished posts send nothing", async () => {
  const db = await freshDb();
  await confirmed(db, "r0@example.com");
  await addPost(db, { id: "old", publishAt: T0 - 5 * 24 * HOUR });
  await addPost(db, { id: "later", publishAt: T0 + 24 * HOUR });
  await addPost(db, { id: "now", publishAt: T0 });
  const none = createEmailGate({ db, transport: null, secret: SECRET });
  const t = await newsletterTick({ db, gate: none, base: BASE, secret: SECRET, now: T0 + HOUR });
  assert.deepEqual(t, { queued: 2, sent: 0, failed: 0, stopped: "no_transport" });
  const issues = await recentIssues(db);
  assert.deepEqual(issues.map((i) => [i.postId, i.status]).sort(), [["now", "sending"], ["old", "skipped"]], "a backlog is never mailed; a future post waits");

  await db.execute("UPDATE posts SET status = 'unpublished' WHERE id = 'now'");
  const { gate, sent } = fakeGate(db);
  await newsletterTick({ db, gate, base: BASE, secret: SECRET, now: T0 + 2 * HOUR });
  assert.equal(sent.length, 0);
  assert.equal((await recentIssues(db)).find((i) => i.postId === "now").status, "stopped");
});

test("the emails: text and HTML say the same, and everything is escaped", () => {
  const c = confirmEmail({ link: `${BASE}/newsletter/confirm?t=abc`, site: BASE });
  assert.ok(c.text.includes(`${BASE}/newsletter/confirm?t=abc`) && c.html.includes(`${BASE}/newsletter/confirm?t=abc`));
  assert.ok(!c.text.includes("—") && !c.html.includes("—"), "no em dashes");
  const p = postEmail({ title: "A <b> & c", summary: "x", url: `${BASE}/blog/a`, unsubscribeUrl: `${BASE}/u?s=1&k=2`, site: BASE });
  assert.ok(p.html.includes("A &lt;b&gt; &amp; c") && !p.html.includes("<b>"));
  assert.equal(p.subject, "A <b> & c");
  assert.equal(postEmail({ title: "T", summary: null, url: "u", unsubscribeUrl: "v", site: BASE, test: true }).subject, "[Test] T");
});
