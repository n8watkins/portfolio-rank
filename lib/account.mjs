// A signed-in account's own data: everything stored against its id, to
// download (accountData) or to delete at once (deleteAccount). The id is the
// rater id, "gh:<GitHub id number>" or "em:<email account id>" (lib/rater.ts).
//
// Kept on deletion, because they hold no one's identity: anonymous
// counts (game_totals, poll option counts; the vote count follows the log) and a
// portfolio's own state (a removal or hidden grade stays in force; the
// account is struck from who asked for it). The leaderboard drops the deleted
// votes at its next recompute: the comparison mirror is cleaned against the
// vote log (lib/ranking/store.mjs). A deleted grade's screenshots are the
// caller's to delete from the bucket (gradeShotKeys, before deleteAccount).

/** The rows that belong to an account, per table, as SQL over ?1 (the id). */
const OWN = [
  { table: "votes", where: "rater_id = ?1" },
  { table: "likes", where: "rater_id = ?1" },
  { table: "list_items", where: "list_id IN (SELECT id FROM lists WHERE owner = ?1)" },
  { table: "lists", where: "owner = ?1" },
  { table: "matchups", where: "rater_id = ?1" },
  { table: "poll_votes", where: "voter = ?1" },
  { table: "quiz_guesses", where: "player = ?1" },
  { table: "quiz_plays", where: "player = ?1" },
  { table: "player_counters", where: "player = ?1" },
  { table: "player_visits", where: "player = ?1" },
  { table: "gem_watch", where: "player = ?1" },
  { table: "badges", where: "player = ?1" },
  { table: "badge_checks", where: "player = ?1" },
  { table: "claims", where: "owner = ?1" },
  { table: "comparisons", where: "rater_id = ?1" },
  // Email accounts (lib/signin): pending sign-in links first, then the account with its address.
  { table: "email_signin_tokens", where: "email IN (SELECT email FROM email_accounts WHERE 'em:' || id = ?1)" },
  { table: "email_accounts", where: "'em:' || id = ?1" },
];

/**
 * Grade requests made while signed in: the grader stores only a keyed hash
 * of the requester (lib/grader/server.ts keyed("visitor", id)), so these are
 * SQL over ?1 = that hash. The job's waiting emails, one-time links and
 * Gemini queue request (which can hold an email address) go with it, and are
 * listed before it so they are deleted first.
 */
const JOBS = "SELECT id FROM grade_jobs WHERE visitor = ?1";
const GRADE_OWN = [
  { table: "grade_emails", where: `job_id IN (${JOBS})` },
  { table: "grade_links", where: `job_id IN (${JOBS})` },
  { table: "people_requests", where: `(CASE WHEN json_valid(meta) THEN json_extract(meta, '$.grade_job') END) IN (${JOBS})` },
  { table: "grade_jobs", where: "visitor = ?1" },
];

/** Columns that name who did something to a portfolio: struck out, the record kept. */
const ACTORS = [
  { table: "claim_log", column: "actor" },
  { table: "regrade_requests", column: "requested_by" },
  { table: "portfolio_owner", column: "removed_by" },
];

const DELETED = "deleted-account";

async function hasTable(db, table) {
  const r = await db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", args: [table] });
  return r.rows.length > 0;
}

/** The screenshot keys of the account's grade requests (gradeVisitor as for accountData). */
export async function gradeShotKeys(db, gradeVisitor) {
  if (!gradeVisitor || !(await hasTable(db, "grade_jobs"))) return [];
  const r = await db.execute({ sql: "SELECT shot_key FROM grade_jobs WHERE visitor = ?1 AND shot_key IS NOT NULL", args: [gradeVisitor] });
  return r.rows.map((row) => String(row.shot_key));
}

/** The account's own rows as [{ table, where, args }]: by its id, and its grade requests by gradeVisitor. */
async function ownRows(db, id, gradeVisitor) {
  const out = [];
  for (const o of OWN) if (await hasTable(db, o.table)) out.push({ ...o, args: [id] });
  if (gradeVisitor && (await hasTable(db, "grade_jobs"))) {
    for (const o of GRADE_OWN) if (await hasTable(db, o.table)) out.push({ ...o, args: [gradeVisitor] });
  }
  return out;
}

/**
 * Everything held about an account, as plain JSON: { account, exportedAt,
 * tables: { <table>: rows } }. Tables with nothing for it are left out.
 * gradeVisitor is the account's keyed grader id (keyed("visitor", id)).
 * @param {any} db
 * @param {string} id
 * @param {{ login?: string, now?: Date, gradeVisitor?: string }} [opts]
 */
export async function accountData(db, id, { login, now = new Date(), gradeVisitor } = {}) {
  const tables = {};
  for (const { table, where, args } of await ownRows(db, id, gradeVisitor)) {
    const r = await db.execute({ sql: `SELECT * FROM ${table} WHERE ${where}`, args });
    if (r.rows.length) tables[table] = r.rows.map((row) => ({ ...row }));
  }
  for (const { table, column } of ACTORS) {
    if (!(await hasTable(db, table))) continue;
    const r = await db.execute({ sql: `SELECT * FROM ${table} WHERE ${column} = ?`, args: [id] });
    if (r.rows.length) tables[table] = r.rows.map((row) => ({ ...row }));
  }
  return { account: { id, login: login ?? null }, exportedAt: now.toISOString(), tables };
}

/**
 * Deletes an account's data in one transaction (a write batch: all of it or
 * none). Returns the rows deleted per table. gradeVisitor as for
 * accountData. Counters over votes (vote_totals, star_counts) follow the
 * deleted votes through their triggers (lib/schema.mjs COUNTERS), in the
 * same transaction.
 * @param {any} db
 * @param {string} id
 * @param {{ gradeVisitor?: string }} [opts]
 */
export async function deleteAccount(db, id, { gradeVisitor } = {}) {
  if (!/^(gh:\d+|em:[A-Za-z0-9_-]{16})$/.test(String(id))) throw new Error("not an account id");
  const own = await ownRows(db, id, gradeVisitor);
  const actors = [];
  for (const a of ACTORS) if (await hasTable(db, a.table)) actors.push(a);
  const res = await db.batch(
    [
      ...own.map(({ table, where, args }) => ({ sql: `DELETE FROM ${table} WHERE ${where}`, args })),
      ...actors.map(({ table, column }) => ({ sql: `UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`, args: [DELETED, id] })),
    ],
    "write"
  );
  return Object.fromEntries(own.map((o, i) => [o.table, res[i].rowsAffected]));
}
