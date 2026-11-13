// The staging site (wrangler.jsonc env.staging, DEPLOY.md "Staging"): it is
// never indexed, never spends the production Gemini quota and never writes
// to production's buckets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJsonc } from "../scripts/check-worker-exports.mjs";
import { DEFAULT_EMAIL_CAPS, emailCaps } from "../lib/email/gate.mjs";
import { STAGING_ROBOTS_TXT, markStaging, stagingRobots } from "../worker/staging.ts";
import { STAGING_CRON_ALIASES, jobCron } from "../worker/crons.ts";

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

test("staging runs production's schedule, with its Gemini held far below production's day", () => {
  assert.ok(config.triggers.crons.length > 0, "production keeps its crons");
  // The same jobs, the hourly and five-minute ones less often (worker/crons.ts).
  assert.deepEqual(staging.triggers.crons.map(jobCron).sort(), [...config.triggers.crons].sort());
  for (const [alias, cron] of Object.entries(STAGING_CRON_ALIASES)) {
    assert.ok(staging.triggers.crons.includes(alias), alias);
    assert.ok(config.triggers.crons.includes(cron), cron);
  }
  assert.match(readFileSync("worker/night.ts", "utf8"), /PEOPLE_QUEUE_CRON = "15 \* \* \* \*"/);
  assert.match(readFileSync("worker/grader.ts", "utf8"), /GRADER_CRON = "\*\/5 \* \* \* \*"/);
  assert.match(readFileSync("worker/index.ts", "utf8"), /const cron = jobCron\(controller\.cron\)/);
  const quota = JSON.parse(staging.vars.GEMINI_DAILY_QUOTA);
  for (const n of Object.values(quota)) assert.ok(n <= 50, `staging quota ${n}`);
  const budget = JSON.parse(staging.vars.GEMINI_BUDGET);
  for (const stage of ["library", "regrade", "experiment"]) assert.equal(budget.stages[stage].cap, 0, stage);
  assert.ok(Number(staging.vars.STAGING_DRAFTS_PER_DAY) <= 1);
  assert.equal(staging.vars.NEWSLETTER_ENABLED, "true");
  assert.equal(config.vars.NEWSLETTER_ENABLED, "true", "on in production: the owner's stored switch (off by default) decides");
  // Staging shares the owner's one Kit account: it only ever makes drafts, whatever the var says (worker/newsletter.ts).
  assert.equal(staging.vars.KIT_BROADCAST_MODE, "draft");
  assert.equal(config.vars.KIT_BROADCAST_MODE, "send");
  assert.match(readFileSync("worker/newsletter.ts", "utf8"), /mode: staging \? "draft" :/);
});

test("staging has its own address, Worker, ISR cache bucket and Workflow", () => {
  assert.equal(staging.vars.SITE_ENV, "staging");
  assert.equal(config.vars.SITE_ENV, "production");
  assert.equal(staging.vars.SITE_URL, "https://staging.portfoliorank.dev");
  assert.deepEqual(staging.routes, [
    { pattern: "staging.portfoliorank.dev", custom_domain: true },
    { pattern: "staging.portfoliorank.n8builds.dev", custom_domain: true },
  ]);
  // Its own Worker calls itself; the mailroom (sign-in links) is shared with production, under PortfolioRank's app.
  assert.deepEqual(staging.services, [
    { binding: "WORKER_SELF_REFERENCE", service: `${config.name}-staging` },
    { binding: "MAILROOM", service: "mailroom", entrypoint: "Mailroom", props: { app: "portfoliorank-staging" } },
  ]);
  const bucket = (c, binding) => c.r2_buckets.find((b) => b.binding === binding).bucket_name;
  assert.notEqual(bucket(staging, "NEXT_INC_CACHE_R2_BUCKET"), bucket(config, "NEXT_INC_CACHE_R2_BUCKET"));
  assert.notEqual(staging.workflows[0].name, config.workflows[0].name);
});

// Staging's own caps and allowlist; production keeps its Gemini caps in
// secrets and never emails through an allowlist.
const STAGING_ONLY_VARS = ["EMAIL_CAPS", "GEMINI_BUDGET", "GEMINI_DAILY_QUOTA", "STAGING_DRAFTS_PER_DAY", "STAGING_EMAIL_TO"];

test("staging repeats every production var and binding (wrangler does not inherit them)", () => {
  assert.deepEqual(Object.keys(staging.vars).filter((k) => !STAGING_ONLY_VARS.includes(k)).sort(), Object.keys(config.vars).sort());
  for (const k of STAGING_ONLY_VARS) assert.equal(config.vars[k], undefined, `${k} is staging's only`);
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
