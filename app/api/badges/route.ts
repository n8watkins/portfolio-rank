import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { clientIp, ipKey, sameOrigin } from "@/lib/polls/server";
import { isKnownPortfolio } from "@/lib/roster";
import { BADGES, checkBadges, listBadges, recordEvent } from "@/lib/games/badges.mjs";
import { PRIVATE, currentPlayer, earlyUntil, fail, gamesEnabled, getPool, off, overLimit, rateLimited } from "@/lib/games/server";

// Badges (GAMES_V2), for the signed-in account or the guest's cookie (a
// guest's badges move to their account at sign-in, app/api/claim).
// GET  /api/badges -> { badges, counters, eye, signedIn }
//   badges  every badge, earned or locked: { id, name, how, hue, counter,
//           target, progress, earned, earnedAt, new }; `new` is true the
//           first time an earned badge is listed (show the toast once)
// POST /api/badges { kind: "share" } | { kind: "visit", url }
//   records what only a badge needs (a share; a portfolio opened, on the
//   list) -> { recorded, badges: [ids earned now] }
//   400 bad_request | unknown_portfolio, 403 bad_origin, 429 rate_limited
export const dynamic = "force-dynamic";
const HOUR = 60 * 60 * 1000;

export async function GET() {
  if (!gamesEnabled()) return off();
  await ensureSchema();
  const player = await currentPlayer({ create: false });
  if (!player) {
    return NextResponse.json(
      {
        badges: BADGES.map((b) => ({ ...b, progress: 0, earned: false, earnedAt: null, new: false })),
        counters: null,
        eye: null,
        signedIn: false,
      },
      { headers: PRIVATE }
    );
  }
  const out = await listBadges(db(), player.id, { pool: await getPool(), signedIn: player.signedIn, earlyUntil: earlyUntil() });
  return NextResponse.json({ ...out, signedIn: player.signedIn }, { headers: PRIVATE });
}

export async function POST(req: Request) {
  if (!gamesEnabled()) return off();
  if (!sameOrigin(req)) return fail("bad_origin", 403);
  let body: { kind?: unknown; url?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", 400);
  }
  const kind = body?.kind;
  if (kind !== "share" && kind !== "visit") return fail("bad_request", 400);
  const url = typeof body.url === "string" ? body.url : undefined;
  if (kind === "visit" && (!url || !isKnownPortfolio(url))) return fail("unknown_portfolio", 400);
  await ensureSchema();
  const player = (await currentPlayer({ create: true }))!;
  const ip = clientIp(req);
  const over = await overLimit([
    { key: `badge-event:b:${player.browser || player.id}`, limit: 120, windowMs: HOUR },
    ...(ip ? [{ key: `badge-event:ip:${ipKey(ip)}`, limit: 600, windowMs: HOUR }] : []),
  ]);
  if (over) return rateLimited(over);
  const recorded = await recordEvent(db(), player.id, kind, { url });
  const badges = recorded
    ? (await checkBadges(db(), player.id, { pool: await getPool(), signedIn: player.signedIn, earlyUntil: earlyUntil() })).awarded
    : [];
  return NextResponse.json({ recorded, badges }, { headers: PRIVATE });
}
