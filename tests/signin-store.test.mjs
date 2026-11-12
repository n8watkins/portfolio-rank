// Email sign-in's store and its email path (lib/signin/store.mjs,
// lib/email/gate.mjs) on an in-memory database: links work once and for 15
// minutes, an address has one account, sign-in emails have their own
// per-address cap, and the mailroom transport maps kinds and fails loudly.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { TOKEN_TTL_MS, consumeToken, issueToken, maskEmail, normalizeEmail, peekToken, pruneTokens, safeCallback } from "../lib/signin/store.mjs";
import { createEmailGate, emailTransport } from "../lib/email/gate.mjs";

const SECRET = "test-secret";
const T0 = Date.UTC(2026, 10, 12, 18);

async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signin-"));
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(db);
  return db;
}

test("addresses, masks and callbacks", () => {
  assert.equal(normalizeEmail("  Ada@Example.COM "), "ada@example.com");
  assert.equal(normalizeEmail("nope"), null);
  assert.equal(maskEmail("ada@example.com"), "ad***@example.com");
  assert.equal(safeCallback("/top?x=1"), "/top?x=1");
  for (const bad of ["https://evil.example", "//evil.example", "/\\evil", "top"]) assert.equal(safeCallback(bad), null);
});

test("a link works once, for 15 minutes, and one address is one account", async () => {
  const db = await freshDb();
  const t1 = await issueToken(db, { email: "ada@example.com", callback: "/play", now: T0 });
  assert.deepEqual(await peekToken(db, t1, { now: T0 + 1000 }), { email: "ada@example.com", callback: "/play" });
  const first = await consumeToken(db, t1, { now: T0 + 2000, secret: SECRET });
  assert.match(first.account.id, /^em:[A-Za-z0-9_-]{16}$/);
  assert.equal(first.callback, "/play");
  assert.deepEqual(await consumeToken(db, t1, { now: T0 + 3000, secret: SECRET }), { error: "used" });

  const t2 = await issueToken(db, { email: "ada@example.com", now: T0 + 10_000 });
  const second = await consumeToken(db, t2, { now: T0 + 11_000, secret: SECRET });
  assert.equal(second.account.id, first.account.id, "the same address finds the same account");

  const t3 = await issueToken(db, { email: "ada@example.com", now: T0 });
  assert.deepEqual(await consumeToken(db, t3, { now: T0 + TOKEN_TTL_MS + 1, secret: SECRET }), { error: "expired" });
  assert.deepEqual(await consumeToken(db, "x".repeat(43), { now: T0, secret: SECRET }), { error: "invalid" });
  assert.deepEqual(await consumeToken(db, "short", { now: T0, secret: SECRET }), { error: "invalid" });

  // Two clicks at once: only one signs in.
  const t4 = await issueToken(db, { email: "bob@example.com", now: T0 });
  const both = await Promise.all([consumeToken(db, t4, { now: T0 + 1, secret: SECRET }), consumeToken(db, t4, { now: T0 + 1, secret: SECRET })]);
  assert.equal(both.filter((r) => "account" in r).length, 1);

  assert.ok((await pruneTokens(db, { now: T0 + 2 * 86_400_000 })) >= 1);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM email_signin_tokens")).rows[0].n, 0);
});

test("sign-in emails have their own per-address cap, apart from reports", async () => {
  const db = await freshDb();
  const sent = [];
  const transport = { name: "memory", send: async (m) => void sent.push(m) };
  const gate = createEmailGate({ db, transport, caps: { day: 50, perRecipient: 2, perRecipientByKind: { signin: 3 }, kinds: { signin: 10, "grade-report": 10 }, reserve: {} }, secret: SECRET, now: () => new Date(T0) });
  const mail = { to: "ada@example.com", subject: "s", text: "t" };
  for (let i = 0; i < 3; i++) assert.deepEqual(await gate.send({ kind: "signin", ...mail }), { sent: true });
  assert.deepEqual(await gate.send({ kind: "signin", ...mail }), { sent: false, reason: "cap:recipient" });
  // Reports to the same address still go out: the sign-in links don't count against them.
  assert.deepEqual(await gate.send({ kind: "grade-report", ...mail }), { sent: true });
  assert.deepEqual(await gate.send({ kind: "grade-report", ...mail }), { sent: true });
  assert.deepEqual(await gate.send({ kind: "grade-report", ...mail }), { sent: false, reason: "cap:recipient" });
});

test("the mailroom transport sends the mailroom kind and fails when the mailroom refuses", async () => {
  const calls = [];
  const env = { MAILROOM: { send: async (m) => (calls.push(m), m.to === "no@example.com" ? { ok: false, code: "suppressed" } : { ok: true }) } };
  const t = emailTransport(env, { via: "mailroom" });
  assert.equal(t.name, "mailroom");
  await t.send({ to: "ada@example.com", subject: "s", text: "t", kind: "signin", key: "k1" });
  assert.equal(calls[0].kind, "signin");
  assert.equal(calls[0].key, "k1");
  assert.equal(calls[0].fromName, "PortfolioRank");
  await assert.rejects(t.send({ to: "no@example.com", subject: "s", text: "t", kind: "signin" }), /suppressed/);
  assert.equal(emailTransport({}, { via: "mailroom" }), null, "no binding, no transport");
});
