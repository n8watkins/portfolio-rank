// What staging runs on a schedule (wrangler.jsonc env.staging triggers,
// DEPLOY.md "Staging"). Staging prepares changes for a release; it is not a
// second production, so it must not repeat production's outside calls (Gemini
// or any AI model, other people's sites, GitHub dispatch, Kit, email). It runs
// on a schedule only the tasks below that make no outside call and are needed
// either for the site to look right or to finish something a person did on it.
//
// SCHEDULED_TASKS lists every task the scheduled() handler (./index.ts) can
// run, by the name it has there, grouped by the production cron that runs it.
// STAGING_TASKS is the allowlist: a task not in it does not run on staging,
// and tests/staging-crons.test.mjs fails when a task is in the handler but in
// neither list, so nobody adds one without deciding. Production runs every
// task whatever these lists say (taskRuns). Plain data, so the tests can
// import this file.
//
// Staging's cron strings differ from production's for the hourly and
// five-minute groups (less often, to keep its CPU time low); each is mapped
// to the production cron whose tasks it runs (STAGING_CRON_ALIASES, with
// PEOPLE_QUEUE_CRON in ./night.ts and GRADER_CRON in ./grader.ts;
// tests/staging.test.mjs keeps them equal).
export const STAGING_CRON_ALIASES: Readonly<Record<string, string>> = {
  "15 */6 * * *": "15 * * * *",
  "*/30 * * * *": "*/5 * * * *",
};

/** The production cron whose jobs this trigger runs. */
export const jobCron = (cron: string): string => STAGING_CRON_ALIASES[cron] ?? cron;

/** The group of tasks each production cron runs. */
export const CRON_GROUPS: Readonly<Record<string, string>> = {
  "30 3 * * *": "nightly",
  "30 4 * * *": "nightly",
  "15 * * * *": "hourly",
  "0 16 * * 1": "weekly",
  "*/5 * * * *": "five-minute",
};

/** Every scheduled task, by group. A new task goes here and either in STAGING_TASKS or not. */
export const SCHEDULED_TASKS: Readonly<Record<string, readonly string[]>> = {
  nightly: ["night start"],
  hourly: [
    "owner removals",
    "removal alerts",
    "edge purge",
    "email caps",
    "night watch",
    "people queue",
    "tiers",
    "freshness",
    "review auto-apply",
    "image library",
  ],
  weekly: ["goals", "model watch"],
  "five-minute": ["grader", "newsletter"],
};

/**
 * What staging runs, and why (DEPLOY.md "Staging" has the table).
 *  - owner removals: database only.
 *  - removal alerts: database, and its alert emails reach STAGING_EMAIL_TO only.
 *  - edge purge: database and the edge cache only.
 *  - tiers: database and the edge cache only, no AI request.
 *  - review auto-apply: database and the edge cache only, plain code.
 *  - people queue: does nothing unless a grade a person asked for on staging
 *    is queued; then it calls Gemini, and only with a staging key of its own.
 *  - grader: does nothing unless a person asked for a grade on staging; then
 *    it sends the report email (STAGING_EMAIL_TO only) and, with a dispatch
 *    token, starts a GitHub capture. Staging has neither today.
 */
export const STAGING_TASKS: readonly string[] = [
  "owner removals",
  "removal alerts",
  "edge purge",
  "tiers",
  "review auto-apply",
  "people queue",
  "grader",
];

/** Whether a task runs here: every task in production, only the allowlist on staging. */
export function taskRuns(task: string, siteEnv: string | undefined): boolean {
  return siteEnv === "staging" ? STAGING_TASKS.includes(task) : true;
}

/** Whether a staging trigger (a cron string in env.staging) has any task left to run. */
export function cronHasStagingTask(cron: string): boolean {
  const group = CRON_GROUPS[jobCron(cron)];
  return (SCHEDULED_TASKS[group] ?? []).some((t) => STAGING_TASKS.includes(t));
}
