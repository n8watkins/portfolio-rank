// Staging runs production's scheduled jobs less often, to keep its CPU time
// low (wrangler.jsonc env.staging triggers): the hourly jobs every six hours
// and the grader's five-minute tick every 30 minutes. Its cron strings differ,
// so each is mapped to the production cron whose jobs it runs
// (PEOPLE_QUEUE_CRON in ./night.ts, GRADER_CRON in ./grader.ts;
// tests/staging.test.mjs keeps them equal); the nightly and weekly crons are
// the same on both. Plain strings, so the tests can import this file.
export const STAGING_CRON_ALIASES: Readonly<Record<string, string>> = {
  "15 */6 * * *": "15 * * * *",
  "*/30 * * * *": "*/5 * * * *",
};

/** The production cron whose jobs this trigger runs. */
export const jobCron = (cron: string): string => STAGING_CRON_ALIASES[cron] ?? cron;
