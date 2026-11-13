// The staging site (wrangler.jsonc env.staging, DEPLOY.md "Staging"): it is
// never indexed, never spends the production Gemini quota and never writes
// to production's buckets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJsonc } from "../scripts/check-worker-exports.mjs";
import { DEFAULT_EMAIL_CAPS, emailCaps } from "../lib/email/gate.mjs";
import { STAGING_ROBOTS_TXT, markStaging, stagingRobots } from "../worker/staging.ts";

const config = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
const staging = config.env.staging;
const STAGING = { SITE_ENV: "staging" };
const PRODUCTION = { SITE_ENV: "production" };

test("staging has its own email caps, every one lower than production's", () => {
  assert.equal(config.vars.EMAIL_CAPS, undefined, "production runs on the defaults");
  const caps = emailCaps(staging.vars.EMAIL_CAPS);
  assert.notDeepEqual(caps, DEFAULT_EMAIL_CAPS, "the staging value parses (a bad one falls back to the defaults)");
  assert.ok(caps.day < DEFAULT_EMAIL_CAPS.day);
  assert.ok(caps.perRecipient <= DEFAULT_EMAIL_CAPS.perRecipient);
  for (const [kind, n] of Object.entries(DEFAULT_EMAIL_CAPS.kinds)) assert.ok(caps.kinds[kind] < n, kind);
  for (const [kind, n] of Object.entries(caps.reserve)) assert.ok(n < caps.kinds[kind] && n <= DEFAULT_EMAIL_CAPS.reserve[kind], kind);
});

test("staging has no Cron Triggers, so nothing there calls Gemini", () => {
  assert.deepEqual(staging.triggers, { crons: [] });
  assert.ok(config.triggers.crons.length > 0, "production keeps its crons");
});

test("staging has its own address, Worker, ISR cache bucket and Workflow", () => {
  assert.equal(staging.vars.SITE_ENV, "staging");
  assert.equal(config.vars.SITE_ENV, "production");
  assert.equal(staging.vars.SITE_URL, "https://staging.portfoliorank.dev");
  assert.deepEqual(staging.routes, [
    { pattern: "staging.portfoliorank.dev", custom_domain: true },
    { pattern: "staging.portfoliorank.n8builds.dev", custom_domain: true },
  ]);
  assert.deepEqual(staging.services, [{ binding: "WORKER_SELF_REFERENCE", service: `${config.name}-staging` }]);
  const bucket = (c, binding) => c.r2_buckets.find((b) => b.binding === binding).bucket_name;
  assert.notEqual(bucket(staging, "NEXT_INC_CACHE_R2_BUCKET"), bucket(config, "NEXT_INC_CACHE_R2_BUCKET"));
  assert.notEqual(staging.workflows[0].name, config.workflows[0].name);
});

test("staging repeats every production var and binding (wrangler does not inherit them)", () => {
  // Staging-only overrides of a default production runs on.
  const STAGING_ONLY = ["EMAIL_CAPS"];
  assert.deepEqual(Object.keys(staging.vars).filter((k) => !STAGING_ONLY.includes(k)).sort(), Object.keys(config.vars).sort());
  const bindings = (c) => [
    ...c.r2_buckets.map((b) => b.binding),
    ...c.durable_objects.bindings.map((b) => b.name),
    ...c.services.map((b) => b.binding),
    ...c.workflows.map((b) => b.binding),
  ].sort();
  assert.deepEqual(bindings(staging), bindings(config));
});

test("staging answers robots.txt itself and disallows everything", async () => {
  const res = stagingRobots(new Request("https://staging.example/robots.txt"), STAGING);
  assert.equal(await res.text(), STAGING_ROBOTS_TXT);
  assert.match(STAGING_ROBOTS_TXT, /^Disallow: \/$/m);
  assert.equal(stagingRobots(new Request("https://staging.example/"), STAGING), null);
  assert.equal(stagingRobots(new Request("https://example/robots.txt"), PRODUCTION), null);
});

test("every staging response says noindex; production's are untouched", () => {
  const res = new Response("hi", { status: 201, headers: { "content-type": "text/html" } });
  const marked = markStaging(res, STAGING);
  assert.equal(marked.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(marked.status, 201);
  assert.equal(marked.headers.get("content-type"), "text/html");
  const prod = new Response("hi");
  assert.equal(markStaging(prod, PRODUCTION), prod);
});
