// Three checks of production's own settings that ran only inside the staging
// tests (tests/staging.test.mjs, compared against production) and stopped
// running when #282 removed staging. None of them can be seen from outside,
// so the post-deploy smoke step (scripts/smoke.mjs) and the health check
// cannot make them; they run here, on every pull request and every release,
// against the wrangler.jsonc and Worker code production deploys:
//   1. the Worker's own cron constants are production's triggers, so the
//      hourly and five-minute jobs (and the weekly one) are ever started
//   2. SITE_ENV is "production" (Write a draft now and the test-mode gates
//      read it: lib/content/jobs.mjs, lib/test-mode.mjs)
//   3. production's email caps are the defaults the tests check
//      (DEFAULT_EMAIL_CAPS), not an override in wrangler.jsonc
// Each check is a pure function, run on the real files and on a drifted
// copy, so the test shows it catches the drift it exists for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJsonc } from "../scripts/check-worker-exports.mjs";
import { CRON_GROUPS } from "../worker/crons.ts";

const config = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
const read = (f) => readFileSync(f, "utf8");

/** Each job cron the Worker matches on, by file and constant, and the group of tasks it must start. */
const JOB_CRONS = [
  ["worker/night.ts", "PEOPLE_QUEUE_CRON", "hourly"],
  ["worker/grader.ts", "GRADER_CRON", "five-minute"],
  ["worker/model-watch.ts", "MODEL_WATCH_CRON", "weekly"],
];

/** Why the Worker's job crons do not match production's triggers, or [] when they do. */
function cronProblems(cfg, source) {
  const out = [];
  for (const [file, name, group] of JOB_CRONS) {
    const cron = source(file).match(new RegExp(`export const ${name} = "([^"]+)"`))?.[1];
    if (!cron) out.push(`${name} not found in ${file}`);
    else if (!cfg.triggers.crons.includes(cron)) out.push(`${name} "${cron}" is not a trigger in wrangler.jsonc: production never runs its ${group} tasks`);
    else if (CRON_GROUPS[cron] !== group) out.push(`${name} "${cron}" is in the ${CRON_GROUPS[cron]} group, not ${group}`);
  }
  return out;
}

test("1. the Worker's job crons are production's triggers, so the hourly, five-minute and weekly tasks run", () => {
  assert.deepEqual(cronProblems(config, read), []);
  // A constant that drifts from its trigger is caught (the hourly tasks would silently stop).
  const drifted = (f) => (f === "worker/night.ts" ? read(f).replace(/PEOPLE_QUEUE_CRON = "[^"]+"/, 'PEOPLE_QUEUE_CRON = "20 * * * *"') : read(f));
  assert.match(cronProblems(config, drifted).join("\n"), /PEOPLE_QUEUE_CRON "20 \* \* \* \*" is not a trigger/);
  // So is a trigger removed from wrangler.jsonc.
  const fewer = { ...config, triggers: { crons: config.triggers.crons.filter((c) => c !== "*/5 * * * *") } };
  assert.match(cronProblems(fewer, read).join("\n"), /GRADER_CRON/);
});

/** Why production's SITE_ENV is wrong, or null. */
const siteEnvProblem = (cfg) => (cfg.vars?.SITE_ENV === "production" ? null : `SITE_ENV is ${JSON.stringify(cfg.vars?.SITE_ENV)}, not "production"`);

test("2. production's SITE_ENV is \"production\"", () => {
  assert.equal(siteEnvProblem(config), null);
  assert.match(siteEnvProblem({ ...config, vars: { ...config.vars, SITE_ENV: "prod" } }), /not "production"/);
  assert.match(siteEnvProblem({ ...config, vars: { ...config.vars, SITE_ENV: undefined } }), /not "production"/);
});

/** Why production's email caps are not the defaults the tests check, or null. */
const emailCapsProblem = (cfg) =>
  cfg.vars && "EMAIL_CAPS" in cfg.vars ? "EMAIL_CAPS is set in wrangler.jsonc: production would run on caps no test checks (change DEFAULT_EMAIL_CAPS in lib/email/gate.mjs instead)" : null;

test("3. production runs on the default email caps (no EMAIL_CAPS override in wrangler.jsonc)", () => {
  assert.equal(emailCapsProblem(config), null);
  assert.match(emailCapsProblem({ ...config, vars: { ...config.vars, EMAIL_CAPS: '{"day":5}' } }), /EMAIL_CAPS is set/);
});
