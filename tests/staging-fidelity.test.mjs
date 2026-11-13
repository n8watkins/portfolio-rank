// Staging as a test bed (docs/audits/release-and-staging.md): "Write a draft
// now" runs there only on staging's own Gemini key and under a lower cap, and
// staging emails only the addresses it is given.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MANUAL_PER_DAY, STAGING_MANUAL_PER_DAY, draftNowPolicy } from "../lib/content/jobs.mjs";
import { emailTransport } from "../lib/email/gate.mjs";

test("Write a draft now: production keeps its cap, staging needs its own key and gets a lower one", () => {
  assert.deepEqual(draftNowPolicy({ SITE_ENV: "production" }), { cap: MANUAL_PER_DAY });
  assert.deepEqual(draftNowPolicy({ SITE_ENV: "staging" }), { error: "no_gemini" });
  assert.deepEqual(draftNowPolicy({ SITE_ENV: "staging", GEMINI_API_KEY: "k" }), { cap: STAGING_MANUAL_PER_DAY });
  assert.deepEqual(draftNowPolicy({ SITE_ENV: "staging", GEMINI_API_KEY: "k", STAGING_DRAFTS_PER_DAY: "3" }), { cap: 3 });
  assert.deepEqual(draftNowPolicy({ SITE_ENV: "staging", GEMINI_API_KEY: "k", STAGING_DRAFTS_PER_DAY: "0" }), { cap: 0 });
  // Never more than production's cap, and a bad value falls back to the default.
  assert.deepEqual(draftNowPolicy({ SITE_ENV: "staging", GEMINI_API_KEY: "k", STAGING_DRAFTS_PER_DAY: "99" }), { cap: MANUAL_PER_DAY });
  assert.deepEqual(draftNowPolicy({ SITE_ENV: "staging", GEMINI_API_KEY: "k", STAGING_DRAFTS_PER_DAY: "lots" }), { cap: STAGING_MANUAL_PER_DAY });
  assert.deepEqual(draftNowPolicy({ SITE_ENV: "test" }), { error: "production_only" });
  assert.deepEqual(draftNowPolicy({}), { error: "production_only" });
});

const binding = () => {
  const sent = [];
  return { sent, SEND_EMAIL: { send: async (m) => sent.push(m.to) } };
};

test("staging emails only the addresses in STAGING_EMAIL_TO", async () => {
  const b = binding();
  const t = emailTransport({ SITE_ENV: "staging", EMAIL_FROM: "x@n8builds.dev", STAGING_EMAIL_TO: " Owner@Example.com , qa@example.com", SEND_EMAIL: b.SEND_EMAIL });
  await t.send({ to: "owner@example.com", subject: "s", text: "t" });
  await assert.rejects(t.send({ to: "someone@example.com", subject: "s", text: "t" }), /STAGING_EMAIL_TO/);
  assert.deepEqual(b.sent, ["owner@example.com"]);

  const none = emailTransport({ SITE_ENV: "staging", EMAIL_FROM: "x@n8builds.dev", SEND_EMAIL: binding().SEND_EMAIL });
  await assert.rejects(none.send({ to: "owner@example.com", subject: "s", text: "t" }), /STAGING_EMAIL_TO/);
});

test("production emails anyone the gate lets through", async () => {
  const b = binding();
  const t = emailTransport({ SITE_ENV: "production", EMAIL_FROM: "x@n8builds.dev", SEND_EMAIL: b.SEND_EMAIL });
  await t.send({ to: "someone@example.com", subject: "s", text: "t" });
  assert.deepEqual(b.sent, ["someone@example.com"]);
});

test("the staging refresh refuses production and anything not named staging, and picks the newest backup", async () => {
  const { refusal, newestBackup } = await import("../scripts/refresh-staging-db.mjs");
  const prod = "libsql://portfolio-rank-n8watkins.aws-us-east-2.turso.io";
  assert.match(refusal(undefined, prod), /not set/);
  assert.match(refusal("libsql://portfolio-rank-staging-n8watkins.aws-us-east-2.turso.io", undefined), /guard/);
  assert.match(refusal(prod, prod), /production/);
  assert.match(refusal("libsql://other-n8watkins.aws-us-east-2.turso.io", prod), /staging/);
  assert.equal(refusal("libsql://portfolio-rank-staging-n8watkins.aws-us-east-2.turso.io", prod), null);
  assert.equal(
    newestBackup(["backups/portfoliorank-2026-11-09.json.gz", "backups/portfoliorank-2026-11-12.json.gz", "backups/portfoliorank-2026-11-10.json.gz", "backups/notes.txt"]),
    "backups/portfoliorank-2026-11-12.json.gz"
  );
  assert.equal(newestBackup([]), null);
});
