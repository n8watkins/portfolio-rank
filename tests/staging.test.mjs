// The staging site (wrangler.jsonc env.staging, DEPLOY.md "Staging"): it is
// never indexed, never spends the production Gemini quota and never writes
// to production's buckets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJsonc } from "../scripts/check-worker-exports.mjs";
import { STAGING_ROBOTS_TXT, markStaging, stagingRobots } from "../worker/staging.ts";

const config = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
const staging = config.env.staging;
const STAGING = { SITE_ENV: "staging" };
const PRODUCTION = { SITE_ENV: "production" };

test("staging's only Cron Trigger is the newsletter's, so nothing there calls Gemini", () => {
  assert.deepEqual(staging.triggers, { crons: ["*/10 * * * *"] });
  assert.ok(config.triggers.crons.length > 1, "production keeps its crons");
  // The scheduled handler matches the newsletter's cron by name before its
  // last line, which would otherwise start tonight's run (worker/index.ts).
  const handler = readFileSync("worker/index.ts", "utf8");
  assert.match(handler, /controller\.cron === NEWSLETTER_CRON\) await newsletterTick\(/);
  assert.ok(handler.indexOf("NEWSLETTER_CRON) await") < handler.indexOf("else await startTonight"));
  assert.match(readFileSync("worker/newsletter.ts", "utf8"), /export const NEWSLETTER_CRON = "\*\/10 \* \* \* \*";/);
  assert.equal(staging.vars.NEWSLETTER_ENABLED, "true");
  assert.equal(config.vars.NEWSLETTER_ENABLED, "false", "off in production until the owner switches it on");
  // Staging shares the owner's one Kit account: it only ever makes drafts, whatever the var says (worker/newsletter.ts).
  assert.equal(staging.vars.KIT_BROADCAST_MODE, "draft");
  assert.equal(config.vars.KIT_BROADCAST_MODE, "send");
  assert.match(readFileSync("worker/newsletter.ts", "utf8"), /mode: staging \? "draft" :/);
});

test("staging has its own address, Worker, ISR cache bucket and Workflow", () => {
  assert.equal(staging.vars.SITE_ENV, "staging");
  assert.equal(config.vars.SITE_ENV, "production");
  assert.equal(staging.vars.AUTH_URL, "https://staging.portfoliorank.n8builds.dev");
  assert.deepEqual(staging.routes, [{ pattern: "staging.portfoliorank.n8builds.dev", custom_domain: true }]);
  // Its own Worker calls itself; the mailroom (sign-in links) is shared with production, under PortfolioRank's app.
  assert.deepEqual(staging.services, [
    { binding: "WORKER_SELF_REFERENCE", service: `${config.name}-staging` },
    { binding: "MAILROOM", service: "mailroom", entrypoint: "Mailroom", props: { app: "portfoliorank" } },
  ]);
  const bucket = (c, binding) => c.r2_buckets.find((b) => b.binding === binding).bucket_name;
  assert.notEqual(bucket(staging, "NEXT_INC_CACHE_R2_BUCKET"), bucket(config, "NEXT_INC_CACHE_R2_BUCKET"));
  assert.notEqual(staging.workflows[0].name, config.workflows[0].name);
});

test("staging repeats every production var and binding (wrangler does not inherit them)", () => {
  assert.deepEqual(Object.keys(staging.vars).sort(), Object.keys(config.vars).sort());
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
