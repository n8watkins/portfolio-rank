// A guest's game progress moves to their account when they sign in
// (app/api/claim calls this before the practice cookie is cleared). The
// guest is identified by the signed practice cookie (anon:<uuid>), so a
// forged value merges nothing. Votes are not touched here: /api/claim
// converts practice votes under its own rules.
//
// Idempotent and in one transaction. Where both have the same thing, the
// account's wins: a quiz the account already started keeps the account's
// answers; counters add up; badges keep the earlier date.
export async function mergeGuest(db, { guest, account }) {
  if (!guest?.startsWith("anon:") || !account || guest === account) return { moved: false };
  const both = [account, guest];
  await db.batch(
    [
      { sql: "UPDATE quiz_guesses SET player = ?1 WHERE player = ?2 AND quiz_id NOT IN (SELECT quiz_id FROM quiz_plays WHERE player = ?1)", args: both },
      { sql: "UPDATE quiz_plays SET player = ?1 WHERE player = ?2 AND quiz_id NOT IN (SELECT quiz_id FROM quiz_plays WHERE player = ?1)", args: both },
      { sql: "DELETE FROM quiz_guesses WHERE player = ?", args: [guest] },
      { sql: "DELETE FROM quiz_plays WHERE player = ?", args: [guest] },
      {
        sql: `INSERT INTO player_counters (player, k, n) SELECT ?1, k, n FROM player_counters WHERE player = ?2 AND true
              ON CONFLICT(player, k) DO UPDATE SET n = n + excluded.n`,
        args: both,
      },
      { sql: "DELETE FROM player_counters WHERE player = ?", args: [guest] },
      { sql: "INSERT OR IGNORE INTO player_visits (player, url) SELECT ?1, url FROM player_visits WHERE player = ?2", args: both },
      { sql: "DELETE FROM player_visits WHERE player = ?", args: [guest] },
      { sql: "INSERT OR IGNORE INTO gem_watch (player, url, pct) SELECT ?1, url, pct FROM gem_watch WHERE player = ?2", args: both },
      { sql: "DELETE FROM gem_watch WHERE player = ?", args: [guest] },
      {
        sql: `INSERT INTO badges (player, badge, earned_at, notified) SELECT ?1, badge, earned_at, notified FROM badges WHERE player = ?2 AND true
              ON CONFLICT(player, badge) DO UPDATE SET earned_at = MIN(earned_at, excluded.earned_at)`,
        args: both,
      },
      { sql: "DELETE FROM badges WHERE player = ?", args: [guest] },
      // The account now holds the guest's poll votes, so one account still
      // means one vote per poll on any browser.
      { sql: "UPDATE OR IGNORE poll_votes SET voter = ?1 WHERE voter = ?2", args: both },
      { sql: "DELETE FROM badge_checks WHERE player IN (?1, ?2)", args: both },
    ],
    "write"
  );
  return { moved: true };
}
