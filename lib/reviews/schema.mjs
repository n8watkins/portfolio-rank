// The owner's review queue (lib/reviews/store.mjs, /admin/review): status
// changes a re-check proposes (scripts written per batch, the first being
// "recheck-543"), one row per site whose listed or ranked state would change.
// Nothing is applied until the owner confirms a row. Additive and idempotent:
// lib/schema.mjs applies it with the rest.
//
//   batch      which re-check wrote the row ("recheck-543")
//   grp        the site's group in that re-check: not_portfolio,
//              delisted_graded, delisted_ungraded, broken or live_ungraded
//   current    its state when the row was written: listed, ranked, hidden
//              or delisted
//   proposed   relist (it is a portfolio: list and rank it), remove (it is
//              not a portfolio) or review (the capture was blocked, so no
//              grader saw the site: a person looks; nothing to apply)
//   agreed     1 when the graders agree (pre-ticked), 0 when they disagree
//              (flagged for the owner, never pre-ticked)
//   off_list   1 when the site is no longer on the community list
//   shot_key   the re-check's capture (/shots/<shot_key>/hero.jpg, mobile.jpg)
//   verdicts   JSON: each grader's batched and one-at-a-time answer
//   signals    JSON: the code's portfolio signals, junk rule and capture
//              notes (capture: { action, blocked, failed }: the one-line
//              action taken before the screenshot, why the capture was
//              blocked, why it failed)
//   status     pending, confirmed or rejected; decided_at/decided_by say when
//              and who, applied (JSON) what Confirm did
export const REVIEW_TABLES = [
  `CREATE TABLE IF NOT EXISTS status_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch TEXT NOT NULL,
    url TEXT NOT NULL,
    grp TEXT NOT NULL,
    current TEXT NOT NULL,
    proposed TEXT NOT NULL,
    agreed INTEGER NOT NULL,
    reason TEXT,
    off_list INTEGER NOT NULL DEFAULT 0,
    shot_key TEXT,
    verdicts TEXT NOT NULL,
    signals TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    decided_at TEXT,
    decided_by TEXT,
    applied TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (batch, url)
  )`,
  `CREATE INDEX IF NOT EXISTS status_reviews_status_idx ON status_reviews (status, batch)`,
  `CREATE INDEX IF NOT EXISTS status_reviews_url_idx ON status_reviews (url, status)`,
];
