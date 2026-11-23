// The owner's read-only view of the temporary pool and the archive
// (app/admin/(tools)/health-pool, owner 2026-11-23): what is failing now,
// what is hidden in the temporary pool, what is in the archive, and what came
// back in the last RETURNS_SHOWN_DAYS days. The rules are in
// pipeline/not-working.mjs; this only reads.
//   failing   listed sites on the ladder that are not hidden yet (stages 1 and 2)
//   pool      listed sites hidden in the temporary pool (stage 3), with since
//             when, why, the next check and the day they are archived
//   archive   data/excluded.json entries of the health kinds (inArchive), with
//             when they were archived, why, and the next archive check
//   returned  health_returns since the cut-off, newest first
//   elsewhere listed sites whose listed address failed while the site
//             answered at its own www or https address (not counted)

import { BOT_WALL_REASON } from "../../pipeline/capture-blocked.mjs";
import { ANSWERS_ELSEWHERE_SQL, LEAVE_AFTER_DAYS, NOT_WORKING, POOL_SQL, RETURNS_SHOWN_DAYS, RETURNS_SQL, archiveCheckDue, inArchive } from "../../pipeline/not-working.mjs";

const DAY = 86400000;
const str = (v) => (v == null ? null : String(v));
const missing = (e) => /no such (table|column)/i.test(String(e?.message ?? e));

/**
 * @param {{ execute: Function }} db
 * @param {{ excluded: unknown[], now?: Date }} opts
 */
export async function healthPool(db, { excluded, now = new Date() }) {
  let poolRows = [];
  try {
    poolRows = (await db.execute(POOL_SQL)).rows;
  } catch (e) {
    if (!missing(e)) throw e;
  }
  const sites = poolRows.map((r) => {
    const hidden = Number(r.pool_stage ?? 0) >= NOT_WORKING && String(r.health) === "down";
    const since = str(r.pool_since);
    // A site whose capture met a bot wall is never archived (pipeline/exclusions.mjs planExclusions): it stays in the pool.
    const walled = String(r.capture_reason ?? "").startsWith(BOT_WALL_REASON);
    return {
      url: String(r.url),
      name: str(r.name) ?? "",
      reason: str(r.health_reason) ?? "",
      started: str(r.pool_started_at),
      since,
      next: str(r.pool_next_at),
      hidden,
      walled,
      archiveOn: hidden && !walled && since && Number.isFinite(Date.parse(since)) ? new Date(Date.parse(since) + LEAVE_AFTER_DAYS * DAY).toISOString() : null,
    };
  });
  const today = now.toISOString().slice(0, 10);
  const archive = (Array.isArray(excluded) ? excluded : [])
    .filter(inArchive)
    .map((e) => {
      const due = archiveCheckDue(e);
      return {
        url: String(e.url),
        name: str(e.name) ?? "",
        kind: String(e.kind),
        reason: str(e.reason) ?? "",
        archived: str(e.removed),
        lastChecked: str(e.last_checked),
        // It answered at its last check, but not as the same site (pipeline/exclusions.mjs passesFullCheck): for the owner.
        found: e.found && typeof e.found === "object" ? { finalUrl: str(e.found.final_url), title: str(e.found.title) ?? "", why: str(e.found.why) ?? "" } : null,
        // "" (no date to go by) and a day already past are both checked with the next weekly export.
        next: due && due > today ? due : today,
      };
    })
    .sort((a, b) => String(b.archived ?? "").localeCompare(String(a.archived ?? "")) || a.url.localeCompare(b.url));
  let returned = [];
  try {
    returned = (await db.execute({ sql: RETURNS_SQL, args: [new Date(now.getTime() - RETURNS_SHOWN_DAYS * DAY).toISOString()] })).rows.map((r) => ({
      url: String(r.url),
      at: String(r.at),
      from: String(r.from_where) === "archive" ? "archive" : "pool",
      reason: str(r.reason) ?? "",
      since: str(r.since),
      hidden: Number(r.hidden ?? 0) === 1,
    }));
  } catch (e) {
    if (!missing(e)) throw e;
  }
  let elsewhere = [];
  try {
    elsewhere = (await db.execute(ANSWERS_ELSEWHERE_SQL)).rows.map((r) => ({ url: String(r.url), name: str(r.name) ?? "", at: String(r.answers_at), checked: str(r.health_checked_at) }));
  } catch (e) {
    if (!missing(e)) throw e;
  }
  return { failing: sites.filter((s) => !s.hidden), pool: sites.filter((s) => s.hidden), archive, returned, elsewhere };
}
