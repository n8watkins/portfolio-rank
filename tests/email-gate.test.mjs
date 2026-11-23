// The shared email gate's owner rules and transports (lib/email/gate.mjs). The
// older gate tests (caps, outbox, alerts) live in tests/grader.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { DEFAULT_EMAIL_CAPS, createEmailGate, emailTransport } from "../lib/email/gate.mjs";

const SECRET = "test-secret-not-real";
const T0 = Date.parse("2026-11-10T20:00:00Z");

async function tempDb() {
  const db = createClient({ url: `file:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), "email-gate-")), "db.sqlite")}` });
  await migrate(db);
  return db;
}

const box = () => {
  const sent = [];
  return { sent, transport: { name: "test", send: async (m) => void sent.push(m) } };
}

test("owner mail is not held to the visitors' per-recipient cap, but has its own daily ceiling", async () => {
  const db = await tempDb();
  const b = box();
  const gate = createEmailGate({ db, transport: b.transport, secret: SECRET, now: () => new Date(T0) });
  const results = [];
  for (let i = 0; i < 6; i++) results.push((await gate.send({ kind: "owner-alert", to: "owner@example.com", subject: `a${i}`, text: "t" })).sent);
  assert.deepEqual(results, [true, true, true, true, true, true], "the 4th owner email of a day goes out");
  // A visitor address keeps the plain cap of 3.
  const visitor = [];
  for (let i = 0; i < 4; i++) visitor.push((await gate.send({ kind: "grade-report", to: "v@example.com", subject: "s", text: "t" })).reason ?? "sent");
  assert.deepEqual(visitor, ["sent", "sent", "sent", "cap:recipient"]);
  // The owner's own ceiling still stops a flood.
  const own = DEFAULT_EMAIL_CAPS.perRecipientByKind["owner-alert"];
  assert.ok(own >= 20, "generous");
  const db2 = await tempDb();
  const g2 = createEmailGate({ db: db2, transport: box().transport, secret: SECRET, now: () => new Date(T0), caps: { ...DEFAULT_EMAIL_CAPS, day: 1000, kinds: {}, reserve: {} } });
  let refused = null;
  for (let i = 0; i < own + 1; i++) refused = (await g2.send({ kind: "owner-alert", to: "owner@example.com", subject: "s", text: "t" })).reason ?? null;
  assert.equal(refused, "cap:recipient");
});

test("production emails anyone the gate lets through, by the mailroom and by send_email", async () => {
  const mailed = [];
  const MAILROOM = { send: async (m) => (mailed.push(m.to), { ok: true }) };
  await emailTransport({ SITE_ENV: "production", MAILROOM }, { via: "mailroom" }).send({ to: "anyone@example.com", subject: "s", text: "t", kind: "signin" });
  const SEND_EMAIL = { send: async (m) => mailed.push(m.to) };
  await emailTransport({ SITE_ENV: "production", EMAIL_FROM: "x@n8builds.dev", SEND_EMAIL }).send({ to: "someone@example.com", subject: "s", text: "t" });
  assert.deepEqual(mailed, ["anyone@example.com", "someone@example.com"]);
});
