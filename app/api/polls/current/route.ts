import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { cachedResponse } from "@/lib/edge-cache";
import { readPolls } from "@/lib/polls/store.mjs";
import { publicPolls, type StoredPoll, type UpcomingPoll } from "@/lib/polls/server";
import { SITE_URL } from "@/lib/site";

// GET /api/polls/current -> { poll, next, at }
//   poll  this week's poll with its totals, or null between polls
//   next  the next scheduled poll (question and week only), or null
// Always 200: "no poll this week" is an answer, not a missing resource.
// Public and cached at the edge for a minute, like GET /api/polls.
export const dynamic = "force-dynamic";
const MAX_AGE = 60;

export async function GET() {
  return cachedResponse(`${SITE_URL}/api/polls/current`, async () => {
    await ensureSchema();
    const now = new Date();
    const read = (await readPolls(db(), { now, past: 1, upcoming: 1 })) as { active: StoredPoll | null; upcoming: UpcomingPoll[] };
    const poll = read.active ? (await publicPolls([read.active]))[0] : null;
    return NextResponse.json({ poll, next: read.upcoming[0] ?? null, at: now.toISOString() }, { headers: { "cache-control": `public, max-age=${MAX_AGE}` } });
  });
}
