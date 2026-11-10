import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { cachedResponse } from "@/lib/edge-cache";
import { PAST_DEFAULT, PAST_MAX, readPolls } from "@/lib/polls/store.mjs";
import { publicPolls, type StoredPoll } from "@/lib/polls/server";
import { SITE_URL } from "@/lib/site";

// GET /api/polls?past=12 -> { active, past, at }
//   active  this week's poll, or null
//   past    closed polls, newest first (1 to 52, default 12)
// Totals and percentages only, never who voted for what. Public and the
// same for everyone, so it is cached at the edge for a minute: one database
// read (a handful of indexed rows) per data center a minute (docs/COSTS.md
// section C). A visitor's own vote comes from GET /api/polls/<id>/vote.
export const dynamic = "force-dynamic";
const MAX_AGE = 60;

export async function GET(req: Request) {
  const asked = Number(new URL(req.url).searchParams.get("past") ?? PAST_DEFAULT);
  const past = Number.isInteger(asked) ? Math.min(Math.max(asked, 1), PAST_MAX) : PAST_DEFAULT;
  return cachedResponse(`${SITE_URL}/api/polls?past=${past}`, async () => {
    await ensureSchema();
    const now = new Date();
    const read = (await readPolls(db(), { now, past })) as { active: StoredPoll | null; past: StoredPoll[] };
    const [active, ...rest] = await publicPolls(read.active ? [read.active, ...read.past] : [...read.past]);
    const body = read.active ? { active, past: rest } : { active: null, past: active ? [active, ...rest] : [] };
    return NextResponse.json({ ...body, at: now.toISOString() }, { headers: { "cache-control": `public, max-age=${MAX_AGE}` } });
  });
}
