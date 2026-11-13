import { NextResponse } from "next/server";
import feed from "@/data/feed.json";
import { BASE_ELO, eloUpdate, pairKey } from "@/lib/elo";
import { db, ensureSchema } from "@/lib/db";
import { hiddenUrls, isKnownPortfolio } from "@/lib/roster";
import {
  ANON_MAX_DRAWS_PER_DAY,
  ANON_VOTE_LIMIT,
  DAILY_VOTE_LIMIT,
  MAX_DRAWS_PER_HOUR,
  STAR_BANK_CAP,
  STAR_PER_VOTES,
  accountTooNew,
  getRater,
  guardConfig,
} from "@/lib/rater";
import { MATCHUP_TTL_MS, issueMatchupToken, verifyMatchupToken } from "@/lib/matchup";
import { starBalance } from "@/lib/stats";
import { sameOrigin } from "@/lib/polls/server";
import { shotBases } from "@/lib/shots";
import { MIN_FACEOFFS } from "@/lib/tiers.mjs";
import { drawCandidates } from "@/lib/play/draw.mjs";
import { applyFaceoff, ensureTierSchema } from "@/lib/tiers-db.mjs";
import type { Portfolio } from "@/app/page";

type Rating = { elo: number; votes: number };

async function getRatings(urls: string[]): Promise<Map<string, Rating>> {
  const placeholders = urls.map(() => "?").join(",");
  const res = await db().execute({
    sql: `SELECT url, elo, votes FROM ratings WHERE url IN (${placeholders})`,
    args: urls,
  });
  return new Map(
    res.rows.map((r) => [
      String(r.url),
      { elo: Number(r.elo), votes: Number(r.votes) },
    ])
  );
}

async function countVotes(raterId: string): Promise<number> {
  const res = await db().execute({
    sql: "SELECT COUNT(*) AS n FROM votes WHERE rater_id = ?",
    args: [raterId],
  });
  return Number(res.rows[0].n);
}

/** Portfolios with MIN_FACEOFFS or more people's face-offs (ratings.votes): drawn less, so the rest catch up. */
async function settledUrls(): Promise<Set<string>> {
  const res = await db().execute({ sql: "SELECT url FROM ratings WHERE votes >= ?", args: [MIN_FACEOFFS] });
  return new Set(res.rows.map((r) => String(r.url)));
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Each roster site's place in the feed: its short id in a pair (`id`) and in `?seen=`. */
const FEED_INDEX = new Map((feed as Portfolio[]).map((p, i) => [p.url, i]));
/** At most this many ids are read from `?seen=` (a long session forgets its oldest). */
const SEEN_MAX = 400;

/** `?seen=3,17,…`: feed indices the browser already showed this session. */
function seenOf(req: Request): Set<number> {
  const raw = new URL(req.url).searchParams.get("seen") ?? "";
  const ids = raw.split(",").slice(-SEEN_MAX).map(Number).filter(Number.isInteger);
  return new Set(ids);
}

export async function GET(req: Request) {
  await ensureSchema();
  const rater = await getRater();
  // Keep hidden sites out of matchups (same rule as browse: lib/roster), and
  // the ones this browser already saw this session, so no portfolio comes
  // back; when nearly all are seen, the whole roster is open again.
  const hidden = await hiddenUrls();
  const listed = (feed as Portfolio[]).filter((p) => !hidden.has(p.url));
  const seen = seenOf(req);
  const fresh = listed.filter((p) => !seen.has(FEED_INDEX.get(p.url)!));
  const pool = fresh.length >= 8 ? fresh : listed;

  // Sample a handful of distinct entries, mostly from portfolios that still
  // need face-offs for their own tier (lib/tiers.mjs MIN_FACEOFFS), then face
  // off the two least-voted, so every portfolio reaches its tier and every
  // vote goes where the rating is most uncertain.
  const candidates = drawCandidates(pool, await settledUrls()) as Portfolio[];
  const ratings = await getRatings(candidates.map((p) => p.url));
  candidates.sort(
    (a, b) => (ratings.get(a.url)?.votes ?? 0) - (ratings.get(b.url)?.votes ?? 0)
  );

  // Every rater, practice visitors included: record the served pair (a vote
  // must be for it) and cap redraws, so skipping until a chosen site shows up
  // doesn't pay - neither for an official vote nor for a practice vote that
  // is claimed at sign-in. Signed-in raters get MAX_DRAWS_PER_HOUR (plus the
  // optional HUMAN_MAX_DRAWS_PER_DAY), practice visitors ANON_MAX_DRAWS_PER_DAY.
  const now = Date.now();
  const dayCap =
    rater.type === "human" ? guardConfig().humanMaxDrawsPerDay : ANON_MAX_DRAWS_PER_DAY;
  const tx = await db().transaction("write");
  try {
    const row = (
      await tx.execute({
        sql: "SELECT window_start, draws, day_start, day_draws FROM matchups WHERE rater_id = ?",
        args: [rater.id],
      })
    ).rows[0];
    const inHour = row && Number(row.window_start) > now - HOUR_MS;
    const inDay = row && row.day_start != null && Number(row.day_start) > now - DAY_MS;
    const hourDraws = inHour ? Number(row.draws) : 0;
    const dayDraws = inDay ? Number(row.day_draws) : 0;
    if (hourDraws >= MAX_DRAWS_PER_HOUR || (dayCap > 0 && dayDraws >= dayCap)) {
      await tx.rollback();
      return NextResponse.json(
        { error: rater.type === "human" ? "too_many_draws" : "signin_required" },
        { status: 429 }
      );
    }
    await tx.execute({
      sql: `INSERT INTO matchups (rater_id, pair_key, issued_at, window_start, draws, day_start, day_draws)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(rater_id) DO UPDATE SET
              pair_key = excluded.pair_key, issued_at = excluded.issued_at,
              window_start = excluded.window_start, draws = excluded.draws,
              day_start = excluded.day_start, day_draws = excluded.day_draws`,
      args: [
        rater.id,
        pairKey(candidates[0].url, candidates[1].url),
        now,
        inHour ? Number(row.window_start) : now,
        hourDraws + 1,
        inDay ? Number(row.day_start) : now,
        dayDraws + 1,
      ],
    });
    // Practice visitors leave a row each; drop ones idle for a week now and then.
    if (Math.random() < 0.01) {
      await tx.execute({
        sql: "DELETE FROM matchups WHERE rater_id LIKE 'anon:%' AND issued_at < ?",
        args: [now - 7 * DAY_MS],
      });
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }

  const shots = await shotBases([candidates[0].url, candidates[1].url]);
  // Which of the two the signed-in rater already likes, so the ♥ renders filled.
  const likedSet =
    rater.type === "human"
      ? new Set(
          (
            await db().execute({
              sql: "SELECT url FROM likes WHERE rater_id = ? AND url IN (?, ?)",
              args: [rater.id, candidates[0].url, candidates[1].url],
            })
          ).rows.map((r) => String(r.url))
        )
      : new Set<string>();
  const withRating = (p: Portfolio) => ({
    ...p,
    id: FEED_INDEX.get(p.url),
    elo: ratings.get(p.url)?.elo ?? BASE_ELO,
    votes: ratings.get(p.url)?.votes ?? 0,
    // Capture base dir (`${SHOTS_BASE_URL}/${shot_key}`) or null; the client
    // builds hero/mobile frame URLs from it. Null → mShots fallback.
    shot: shots.get(p.url) ?? null,
    liked: likedSet.has(p.url),
  });

  const anonVotesUsed =
    rater.type === "anon" ? await countVotes(rater.id) : null;
  const stars = rater.type === "human" ? await starBalance(rater.id) : 0;

  return NextResponse.json({
    a: withRating(candidates[0]),
    b: withRating(candidates[1]),
    // Proof this rater was shown this pair; POST requires it.
    token: issueMatchupToken(rater.id, candidates[0].url, candidates[1].url),
    rater: {
      signedIn: rater.type === "human",
      login: rater.login ?? null,
      anonVotesUsed,
      anonVoteLimit: ANON_VOTE_LIMIT,
      stars,
    },
  });
}

export async function POST(req: Request) {
  // Votes ride on the session cookie: only this site's pages may cast them.
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const winner = body?.winner;
  const loser = body?.loser;
  const wantStar = body?.star === true;
  if (
    typeof winner !== "string" ||
    typeof loser !== "string" ||
    winner === loser
  ) {
    return NextResponse.json({ error: "bad_vote" }, { status: 400 });
  }
  if (!isKnownPortfolio(winner) || !isKnownPortfolio(loser)) {
    return NextResponse.json({ error: "unknown_url" }, { status: 403 });
  }

  await ensureSchema();
  await ensureTierSchema(db());
  const rater = await getRater();
  const key = pairKey(winner, loser);
  // Only a pair the server served to this rater can be voted on.
  if (!verifyMatchupToken(body?.token, rater.id, winner, loser)) {
    return NextResponse.json({ error: "stale_matchup" }, { status: 403 });
  }
  // MIN_GITHUB_ACCOUNT_AGE_DAYS (off unless the owner sets it).
  if (accountTooNew(rater)) {
    return NextResponse.json(
      { error: "account_too_new", minAccountAgeDays: guardConfig().minAccountAgeDays },
      { status: 403 }
    );
  }

  // Everything - the limit checks, the vote insert, and the ELO update - runs
  // in one write transaction. libSQL serializes write transactions, so the
  // gaps that let concurrent requests slip past a check-then-insert (double
  // votes, blown caps, lost-update ELO inflation) are closed. The
  // UNIQUE(rater_id, pair_key) index is the final backstop for the dup check.
  const tx = await db().transaction("write");
  try {
    // Pace votes: a human looks at two screenshots before picking, a script
    // doesn't. Anything faster than one vote per 2s per rater is rejected.
    const recent = await tx.execute({
      sql: "SELECT COUNT(*) AS n FROM votes WHERE rater_id = ? AND created_at > datetime('now', '-2 seconds')",
      args: [rater.id],
    });
    if (Number(recent.rows[0].n) > 0) {
      await tx.rollback();
      return NextResponse.json({ error: "too_fast" }, { status: 429 });
    }

    const daily = await tx.execute({
      sql: "SELECT COUNT(*) AS n FROM votes WHERE rater_id = ? AND created_at > datetime('now', '-1 day')",
      args: [rater.id],
    });
    if (Number(daily.rows[0].n) >= DAILY_VOTE_LIMIT) {
      await tx.rollback();
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }

    // Anon votes are logged (they're still signal) but never move official ELO
    // or any board. There is no sign-in wall (owner, 2026-11-12): a guest
    // keeps voting, within the same daily limit as everyone, and up to
    // ANON_VOTE_LIMIT of these practice votes convert at sign-in (/api/claim).

    // Superstar super-vote: only a signed-in rater with a banked star can spend
    // one. It doubles the ELO weight and flags the vote (= the ⭐ for the winner).
    let useStar = false;
    if (wantStar && rater.type === "human") {
      const sb = await tx.execute({
        sql: "SELECT COUNT(*) AS total, COALESCE(SUM(starred), 0) AS spent FROM votes WHERE rater_id = ?",
        args: [rater.id],
      });
      const bal = Math.max(
        0,
        Math.min(
          Math.floor(Number(sb.rows[0].total) / STAR_PER_VOTES) -
            Number(sb.rows[0].spent),
          STAR_BANK_CAP
        )
      );
      useStar = bal > 0;
    }

    // A vote - official or practice - must be for the pair most recently
    // served to this rater, and spends it: the next vote needs a fresh draw.
    const m = await tx.execute({
      sql: "UPDATE matchups SET pair_key = NULL WHERE rater_id = ? AND pair_key = ? AND issued_at > ?",
      args: [rater.id, key, Date.now() - MATCHUP_TTL_MS],
    });
    if (m.rowsAffected === 0) {
      await tx.rollback();
      return NextResponse.json({ error: "stale_matchup" }, { status: 403 });
    }

    const rres = await tx.execute({
      sql: "SELECT url, elo, votes FROM ratings WHERE url IN (?, ?)",
      args: [winner, loser],
    });
    const map = new Map(
      rres.rows.map((r) => [
        String(r.url),
        { elo: Number(r.elo), votes: Number(r.votes) },
      ])
    );
    const w = map.get(winner) ?? { elo: BASE_ELO, votes: 0 };
    const l = map.get(loser) ?? { elo: BASE_ELO, votes: 0 };
    const updated = eloUpdate(w.elo, l.elo, useStar ? 64 : 32);
    // Human votes move ELO; anon (practice) votes don't, so their delta is 0.
    // Stored so /api/rank/undo can revert exactly what this vote applied.
    const appliedDelta = rater.type === "human" ? updated.delta : 0;

    // Insert first: a UNIQUE violation here means this rater already voted on
    // this matchup (either direction) - caught below as 409.
    const inserted = await tx.execute({
      // served = 1: cast on a pair recorded in matchups; only such practice
      // votes can be claimed (/api/claim).
      sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, delta, starred, served) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
      args: [winner, loser, key, rater.type, rater.id, appliedDelta, useStar ? 1 : 0],
    });

    if (rater.type === "human") {
      // The tier rating of the two portfolios moves at once, in the same transaction (lib/tiers-db.mjs).
      await applyFaceoff(tx, { winner, loser, rater: "human", starred: useStar, voteId: Number(inserted.lastInsertRowid) });
      const upsert = `INSERT INTO ratings (url, elo, votes, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(url) DO UPDATE SET
          elo = excluded.elo, votes = excluded.votes, updated_at = excluded.updated_at`;
      await tx.execute({ sql: upsert, args: [winner, updated.winner, w.votes + 1] });
      await tx.execute({ sql: upsert, args: [loser, updated.loser, l.votes + 1] });
    }

    await tx.commit();

    const anonVotesUsed =
      rater.type === "anon" ? await countVotes(rater.id) : null;
    const stars = rater.type === "human" ? await starBalance(rater.id) : 0;

    return NextResponse.json({
      official: rater.type === "human",
      // For anon votes these are "what would have happened" - shown, not stored.
      winnerElo: updated.winner,
      loserElo: updated.loser,
      delta: updated.delta,
      starred: useStar,
      stars,
      anonVotesUsed,
      anonVoteLimit: ANON_VOTE_LIMIT,
    });
  } catch (e) {
    await tx.rollback().catch(() => {});
    if (/UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e))) {
      return NextResponse.json({ error: "already_voted" }, { status: 409 });
    }
    throw e;
  }
}
