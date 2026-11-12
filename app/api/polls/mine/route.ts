import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { PAST_MAX, myVotes } from "@/lib/polls/store.mjs";
import { POLL_ID, currentVoter } from "@/lib/polls/server";

// GET /api/polls/mine?ids=2026-11-02,2026-11-09 -> { votes: { [id]: option } }
// This visitor's own votes in the listed polls, for "you voted" on /polls,
// whose HTML is the same for everyone and cached. Never cached, never
// shared: it answers only for the browser (signed cookie) and account
// asking, and never issues a cookie.
export const dynamic = "force-dynamic";
const PRIVATE = { "cache-control": "private, no-store" };

export async function GET(req: Request) {
  const ids = [...new Set((new URL(req.url).searchParams.get("ids") ?? "").split(",").filter((id) => POLL_ID.test(id)))].slice(0, PAST_MAX + 1);
  const voter = ids.length ? await currentVoter({ create: false }) : null;
  if (!voter) return NextResponse.json({ votes: {} }, { headers: PRIVATE });
  await ensureSchema();
  const votes = await myVotes(db(), { pollIds: ids, voter: voter.voter, browser: voter.browser });
  return NextResponse.json({ votes }, { headers: PRIVATE });
}
