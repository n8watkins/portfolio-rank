// Discovery hands sites that passed the AI screen (and sites the free tools
// added) to the grader's existing queue (docs/DISCOVERY.md "Grading"), at a
// capped pace, and later records how their grade ended.
//
// A hand-off is a grade_jobs row in the `waiting` state with visitor
// "discovery" (lib/grader/jobs.mjs): the grader's tick starts waiting jobs
// while the day's site-wide share has room (worker/grader.ts), captures them
// on GitHub Actions and grades them on Gemini 3.5 like any other request.
// People come first:
// - a waiting person's request starts before any discovery job
//   (waitingJobs), and discovery jobs don't count against people's waiting
//   line (countWaiting);
// - at most perDay hand-offs a quota day, at most `waiting` discovery jobs
//   waiting at once, and none while today's share has fewer than `reserve`
//   places left for people.
import { siteKeyOf } from "../../lib/grader/url.mjs";
import { createJob } from "../../lib/grader/jobs.mjs";
import { graderCaps, siteLeft } from "../../lib/grader/caps.mjs";
import { queue, settle } from "../../lib/discovery/sites.mjs";
import { quotaDay } from "../quota-day.mjs";
import { moveWatermark, readWatermark } from "./watermark.mjs";

export const DISCOVERY_VISITOR = "discovery";
const COUNTER = "handoff"; // a discovery_sources row: { day, n } handed off on that quota day

/** How many sites may be handed off now (pure, for the tests). */
export function handoffRoom({ perDay, handedToday, waitingNow, waitingCap, shareLeft, reserve }) {
  return Math.max(0, Math.min(perDay - handedToday, waitingCap - waitingNow, shareLeft - reserve));
}

/**
 * Records finished grades (queued -> graded, or dropped when the grade said
 * "not a portfolio" or the capture failed), then hands off new sites.
 * @param {any} db
 * @param {{ perDay: number, waiting: number, reserve: number, now?: Date, graderCapsRaw?: string, log?: (s: string) => void }} o
 */
export async function handoff(db, { perDay, waiting, reserve, now = new Date(), graderCapsRaw, log = () => {} }) {
  const out = { graded: 0, notPortfolio: 0, failed: 0, handed: 0 };

  const queued = await queue(db, "queued", 500);
  const done = [];
  for (const row of queued) {
    if (!row.url) continue;
    const r = await db.execute({ sql: "SELECT status, result FROM grade_jobs WHERE site_key = ? AND visitor = ? ORDER BY created_at DESC LIMIT 1", args: [siteKeyOf(row.url), DISCOVERY_VISITOR] });
    const job = r.rows[0];
    if (!job) continue;
    if (String(job.status) === "done") {
      let isPortfolio = true;
      try {
        isPortfolio = JSON.parse(String(job.result ?? "{}")).is_portfolio !== false;
      } catch {
        /* a result we can't read counts as graded */
      }
      done.push(isPortfolio ? { key: row.key, status: "graded" } : { key: row.key, status: "dropped", reason: "not_portfolio" });
      out[isPortfolio ? "graded" : "notPortfolio"]++;
    } else if (String(job.status) === "failed") {
      done.push({ key: row.key, status: "dropped", reason: "dead" });
      out.failed++;
    }
  }
  await settle(db, done, { now });

  if (perDay <= 0) return out;
  const day = quotaDay(now).day;
  const { cursor } = await readWatermark(db, COUNTER);
  const handedToday = cursor?.day === day ? Number(cursor.n) || 0 : 0;
  const w = await db.execute({ sql: "SELECT COUNT(*) AS n FROM grade_jobs WHERE status = 'waiting' AND visitor = ?", args: [DISCOVERY_VISITOR] });
  const room = handoffRoom({
    perDay,
    handedToday,
    waitingNow: Number(w.rows[0]?.n ?? 0),
    waitingCap: waiting,
    shareLeft: await siteLeft(db, { day, caps: graderCaps(graderCapsRaw) }),
    reserve,
  });
  if (room <= 0) {
    log(`hand-off: no room (handed today ${handedToday} of ${perDay}, waiting cap ${waiting}, reserve ${reserve})`);
    return out;
  }
  const rows = (await queue(db, "pending", room)).filter((r) => r.url);
  const moved = [];
  for (const row of rows) {
    await createJob(db, {
      url: row.url,
      siteKey: siteKeyOf(row.url),
      status: "waiting",
      reason: "Found by PortfolioRank's discovery; graded when the day has room.",
      visitor: DISCOVERY_VISITOR,
      now: now.getTime(),
    });
    moved.push({ key: row.key, status: "queued" });
  }
  await settle(db, moved, { now });
  await moveWatermark(db, COUNTER, { day, n: handedToday + moved.length }, { now });
  out.handed = moved.length;
  return out;
}
