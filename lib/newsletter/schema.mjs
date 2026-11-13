// Tables of the blog newsletter (lib/newsletter/store.mjs, AUTOMATION.md
// "Newsletter"). Kit keeps the list (lib/newsletter/kit.mjs), so we store no
// subscriber and no address: only which posts became a Kit broadcast. lib/
// schema.mjs applies these with the rest of the schema; they are idempotent.
//
//   newsletter_issues  one per published post: which post, its state
//                      (queued, creating while the Kit call runs, scheduled
//                      or draft in Kit, stopped, skipped), Kit's broadcast id,
//                      when Kit sends it, and when it was queued and finished
//
// The subscriber and delivery tables of the first, self-sent version held
// addresses; they are dropped wherever they were made (staging only).
import { SWITCH_TABLES } from "./switch.mjs";

export const NEWSLETTER_TABLES = [
  // The owner's on/off switch and its log (lib/newsletter/switch.mjs).
  ...SWITCH_TABLES,
  `CREATE TABLE IF NOT EXISTS newsletter_issues (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    kit_broadcast_id TEXT,
    send_at TEXT
  )`,
  `DROP TABLE IF EXISTS newsletter_deliveries`,
  `DROP TABLE IF EXISTS newsletter_subscribers`,
];

/** Columns added to newsletter_issues after staging first made it. */
export const NEWSLETTER_COLUMNS = [
  ["newsletter_issues", "kit_broadcast_id TEXT"],
  ["newsletter_issues", "send_at TEXT"],
];
