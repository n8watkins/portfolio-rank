// A signed-in account's own data: everything stored against its id, to
// download (accountData) or to delete at once (deleteAccount). The id is the
// rater id, "gh:<GitHub id number>" (lib/rater.ts).
//
// Kept on deletion, because they hold no one's identity: anonymous
// counts (game_totals, poll option counts; the vote count follows the log) and a
// portfolio's own state (a removal or hidden grade stays in force; the
// account is struck from who asked for it). The leaderboard drops the deleted
// votes at its next recompute: the comparison mirror is cleaned against the
// vote log (lib/ranking/store.mjs).

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

/**
 * Everything held about an account, as plain JSON: { account, exportedAt,
 * tables: { <table>: rows } }. Tables with nothing for it are left out.
 * @param {any} db
 * @param {string} id
 * @param {{ login?: string, now?: Date }} [opts]
 */
export async function accountData(db, id, { login, now = new Date() } = {}) {
  const tables = {};
  for (const { table, where } of OWN) {
    if (!(await hasTable(db, table))) continue;
    const r = await db.execute({ sql: `SELECT * FROM ${table} WHERE ${where}`, args: [id] });
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
 * none). Returns the rows deleted per table.
 * @param {any} db
 * @param {string} id
 */
export async function deleteAccount(db, id) {
  if (!/^gh:\d+$/.test(String(id))) throw new Error("not an account id");
  const own = [];
  for (const o of OWN) if (await hasTable(db, o.table)) own.push(o);
  const actors = [];
  for (const a of ACTORS) if (await hasTable(db, a.table)) actors.push(a);
  const res = await db.batch(
    [
      ...own.map(({ table, where }) => ({ sql: `DELETE FROM ${table} WHERE ${where}`, args: [id] })),
      ...actors.map(({ table, column }) => ({ sql: `UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`, args: [DELETED, id] })),
    ],
    "write"
  );
  return Object.fromEntries(own.map((o, i) => [o.table, res[i].rowsAffected]));
}
