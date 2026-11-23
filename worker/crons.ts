// Every task the scheduled() handler (./index.ts) runs, by the name it has
// there, grouped by the cron that runs it (wrangler.jsonc triggers.crons).
// tests/crons.test.mjs fails when a task is in the handler but not listed
// here, or listed here but not run, so this stays the one list of what runs
// on a schedule. Plain data, so the tests can import this file.

/** The group of tasks each cron runs. */
export const CRON_GROUPS: Readonly<Record<string, string>> = {
  "30 3 * * *": "nightly",
  "30 4 * * *": "nightly",
  "15 * * * *": "hourly",
  "0 16 * * MON": "weekly",
  "*/5 * * * *": "five-minute",
};

/** Every scheduled task, by group. A new task in the handler goes here too. */
export const SCHEDULED_TASKS: Readonly<Record<string, readonly string[]>> = {
  nightly: ["night start"],
  hourly: [
    "recheck start",
    "owner removals",
    "removal alerts",
    "edge purge",
    "email caps",
    "night watch",
    "people queue",
    "tiers",
    "review auto-apply",
    "image library",
  ],
  weekly: ["goals", "model watch"],
  "five-minute": ["grader", "newsletter"],
};
