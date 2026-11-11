// Tables of "grade my portfolio" (lib/grader, AUTOMATION.md "Grade my
// portfolio"). Additive and idempotent: lib/schema.mjs applies them with the
// rest of the schema, and the GitHub Actions job (scripts/grade-jobs.mjs)
// calls ensureGraderSchema before it writes.
//
//   grade_jobs     one row per grade request: the unguessable id, the
//                  address, the state, the free checks, the capture, the
//                  grade and the report built from it
//   grade_caps     daily counters for the per-visitor, per-network and
//                  site-wide caps, reserved in one transaction
//   grade_emails   "Get it by email": the address waits here until the
//                  report is ready, and is erased once the email is sent
//   grade_links    the one-time links those emails carry (only a hash of
//                  the nonce is stored)
//   email_sends    the shared email gate's log (lib/email/gate.mjs): one
//                  row per send, which the daily caps count; no address,
//                  only a keyed hash
//   email_outbox   test runs only (EMAIL_TRANSPORT=outbox): the emails a
//                  real transport would have sent
export const GRADER_TABLES = [
  `CREATE TABLE IF NOT EXISTS grade_jobs (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    site_key TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    own_key INTEGER NOT NULL DEFAULT 0,
    visitor TEXT,
    network TEXT,
    quick TEXT,
    quick_fingerprint TEXT,
    final_url TEXT,
    shot_key TEXT,
    page_text TEXT,
    facts TEXT,
    meta TEXT,
    fingerprint TEXT,
    result TEXT,
    report TEXT,
    model TEXT,
    people_request_id INTEGER,
    dispatch_attempts INTEGER NOT NULL DEFAULT 0,
    dispatched_at TEXT,
    dispatch_run TEXT,
    claimed_at TEXT,
    claim_run TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    captured_at TEXT,
    done_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS grade_jobs_status_idx ON grade_jobs (status, created_at)`,
  `CREATE INDEX IF NOT EXISTS grade_jobs_site_idx ON grade_jobs (site_key, created_at)`,
  `CREATE TABLE IF NOT EXISTS grade_caps (
    k TEXT PRIMARY KEY,
    day TEXT NOT NULL,
    n INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS grade_caps_day_idx ON grade_caps (day)`,
  `CREATE TABLE IF NOT EXISTS grade_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    email TEXT,
    email_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS grade_emails_job_addr_idx ON grade_emails (job_id, email_hash)`,
  `CREATE INDEX IF NOT EXISTS grade_emails_status_idx ON grade_emails (status, created_at)`,
  `CREATE TABLE IF NOT EXISTS grade_links (
    nonce_hash TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS email_sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    to_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS email_sends_day_idx ON email_sends (day, kind)`,
  `CREATE INDEX IF NOT EXISTS email_sends_to_idx ON email_sends (to_hash, day)`,
  `CREATE TABLE IF NOT EXISTS email_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    to_addr TEXT NOT NULL,
    subject TEXT NOT NULL,
    text TEXT NOT NULL
  )`,
];

/** Creates the grader tables when missing (safe to repeat). */
export async function ensureGraderSchema(db) {
  await db.batch(GRADER_TABLES, "write");
}
