// Tables of the blog newsletter (lib/newsletter/store.mjs, AUTOMATION.md
// "Newsletter"). Additive and idempotent: lib/schema.mjs applies them with
// the rest of the schema.
//
//   newsletter_subscribers  one row per address: the address, a keyed hash
//                           of it (unique: one row per address), its status
//                           (pending until the confirm link is used, then
//                           confirmed, or unsubscribed), when it signed up,
//                           confirmed and unsubscribed, and the page it
//                           signed up on. The confirm link is kept only as a
//                           hash. Unconfirmed rows go 7 days after sign-up,
//                           unsubscribed rows 30 days after the unsubscribe
//                           (pruneNewsletter).
//   newsletter_issues       one email per published post: which post, when
//                           it was queued and finished, and its state
//                           (sending, sent, stopped)
//   newsletter_deliveries   who an issue went to (subscriber id, never the
//                           address) and how it went; removed with the
//                           subscriber
export const NEWSLETTER_TABLES = [
  `CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    email_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    source TEXT,
    created_at TEXT NOT NULL,
    confirmed_at TEXT,
    unsubscribed_at TEXT,
    confirm_hash TEXT,
    confirm_expires_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS newsletter_subscribers_status_idx ON newsletter_subscribers (status, confirmed_at)`,
  `CREATE INDEX IF NOT EXISTS newsletter_subscribers_confirm_idx ON newsletter_subscribers (confirm_hash)`,
  `CREATE TABLE IF NOT EXISTS newsletter_issues (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS newsletter_deliveries (
    issue_id TEXT NOT NULL,
    subscriber_id TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    at TEXT NOT NULL,
    PRIMARY KEY (issue_id, subscriber_id)
  )`,
  `CREATE INDEX IF NOT EXISTS newsletter_deliveries_subscriber_idx ON newsletter_deliveries (subscriber_id)`,
];
