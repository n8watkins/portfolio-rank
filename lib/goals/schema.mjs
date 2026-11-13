// Tables of the owner's goals (lib/goals/config.mjs, pipeline/goals.mjs).
// Additive and idempotent: lib/schema.mjs applies them with the rest.
//
//   goal_progress  one row per goal and finished week (the Monday that
//                  starts it, Pacific): the numbers measured, whether the
//                  goal held that week, and when it was checked
//   goal_events    one row per goal that was reached: when, the week, which
//                  conditions held, the decision slot offered, and when the
//                  owner was emailed (null until the email went out, so a
//                  failed send is tried again on the next check; once set,
//                  the goal never emails again)
export const GOAL_TABLES = [
  `CREATE TABLE IF NOT EXISTS goal_progress (
    goal_id TEXT NOT NULL,
    week TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    metrics TEXT NOT NULL,
    reached INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (goal_id, week)
  )`,
  `CREATE TABLE IF NOT EXISTS goal_events (
    goal_id TEXT PRIMARY KEY,
    reached_at TEXT NOT NULL,
    reached_week TEXT NOT NULL,
    met TEXT NOT NULL,
    slot_start TEXT,
    notified_at TEXT,
    last_error TEXT
  )`,
];
