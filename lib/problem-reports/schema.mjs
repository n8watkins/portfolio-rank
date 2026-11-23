// Visitors' "Report a problem" notes about a site's profile (owner,
// 2026-11-22: "a report button beside the screenshot that reaches his
// review"). lib/problem-reports/store.mjs writes and reads them; the owner
// sees the open ones on /admin/review. A report is information for the owner
// only: nothing reads this table to rank, list, tier or score a site.
// Additive and idempotent: lib/schema.mjs applies it with the rest.
//
//   url          the site the report is about (the profile's own URL)
//   reason       one of REASONS (store.mjs): screenshot, measurement,
//                not_portfolio, gone, other
//   note         the visitor's optional note, plain text, at most
//                NOTE_MAX characters, or null
//   reporter     a keyed hash of the visitor (signed browser cookie or
//                account; never the raw id), so one visitor has at most one
//                open report per site; cleared when the report is handled,
//                so a reopened report no longer counts as that visitor's
//                (store.mjs reopenReports)
//   status       open or handled
//   created_at   when it was sent (ISO); updated_at when the same visitor
//                sent it again (reason and note replaced)
//   handled_at, handled_by  when and who marked it handled ("admin:<login>")
export const PROBLEM_REPORT_TABLES = [
  `CREATE TABLE IF NOT EXISTS problem_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    reason TEXT NOT NULL,
    note TEXT,
    reporter TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    handled_at TEXT,
    handled_by TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS problem_reports_status_idx ON problem_reports (status, url)`,
  // One open report per visitor and site: a second send updates the first.
  `CREATE UNIQUE INDEX IF NOT EXISTS problem_reports_open_idx ON problem_reports (url, reporter) WHERE status = 'open'`,
];
