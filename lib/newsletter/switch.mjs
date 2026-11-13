// The owner's newsletter switch (AUTOMATION.md "Newsletter"): one stored
// setting, off until the owner turns it on from /admin/blog/newsletter, and
// every change logged with who and when. The newsletter is live only when
// both NEWSLETTER_ENABLED (the deploy-level kill switch) and this switch are
// on; off hides every sign-up form and stops new broadcasts.
//
//   newsletter_settings  k = 'switch': v '1' or '0', when and by whom
//   newsletter_switch_log  every change: on or off, when, by whom

export const SWITCH_TABLES = [
  `CREATE TABLE IF NOT EXISTS newsletter_settings (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS newsletter_switch_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    turned_on INTEGER NOT NULL,
    at TEXT NOT NULL,
    by TEXT
  )`,
];

/** The switch: { on, at, by }; off (never set) by default. */
export async function readSwitch(db) {
  const row = (await db.execute("SELECT v, updated_at, updated_by FROM newsletter_settings WHERE k = 'switch'")).rows[0];
  if (!row) return { on: false, at: null, by: null };
  return { on: String(row.v) === "1", at: String(row.updated_at), by: row.updated_by == null ? null : String(row.updated_by) };
}

/**
 * Turns the newsletter on or off and logs the change, in one write. A no-op change is not logged.
 * @param {any} db @param {boolean} on @param {{ by?: string | null, now?: Date }} [options]
 */
export async function setSwitch(db, on, { by = null, now = new Date() } = {}) {
  const at = new Date(now).toISOString();
  const v = on ? "1" : "0";
  const was = await readSwitch(db);
  if (was.at && was.on === Boolean(on)) return was;
  await db.batch(
    [
      {
        sql: `INSERT INTO newsletter_settings (k, v, updated_at, updated_by) VALUES ('switch', ?, ?, ?)
              ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        args: [v, at, by],
      },
      { sql: "INSERT INTO newsletter_switch_log (turned_on, at, by) VALUES (?, ?, ?)", args: [on ? 1 : 0, at, by] },
    ],
    "write"
  );
  return { on: Boolean(on), at, by };
}

/** The latest changes, newest first. */
export async function switchLog(db, { limit = 10 } = {}) {
  const rows = (await db.execute({ sql: "SELECT turned_on, at, by FROM newsletter_switch_log ORDER BY id DESC LIMIT ?", args: [limit] })).rows;
  return rows.map((r) => ({ on: Number(r.turned_on) === 1, at: String(r.at), by: r.by == null ? null : String(r.by) }));
}
