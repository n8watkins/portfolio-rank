import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { castVote, myVote, rateLimit, readPoll } from "@/lib/polls/store.mjs";
import {
  POLL_ID,
  clientIp,
  currentVoter,
  ipKey,
  publicPolls,
  sameOrigin,
  turnstileRequired,
  verifyTurnstile,
  type StoredPoll,
} from "@/lib/polls/server";

// The visitor's own vote. Never cached, never shared: it answers only for
// the browser (signed cookie) and account asking.
//
// GET  /api/polls/<id>/vote -> { mine: option index | null, open, turnstile }
// POST /api/polls/<id>/vote   { option: number, turnstileToken?: string }
//   200 { mine, poll }   the vote counted; poll carries the fresh totals
//   409 { error: "already_voted", mine, poll }
//   400 bad_request | bad_option, 403 bad_origin | turnstile_failed,
//   404 not_found, 410 closed, 429 rate_limited (Retry-After)
// One vote per visitor: per signed-in account and per browser (the signed
// pr_anon cookie, issued here when missing). Rate limits per browser and
// per IP live in the database (rate_limits). Turnstile is checked when the
// TURNSTILE_SECRET_KEY secret is set (the widget's action: "poll-vote").
export const dynamic = "force-dynamic";
const PRIVATE = { "cache-control": "private, no-store" };
const HOUR = 60 * 60 * 1000;
/** Vote attempts per browser and per IP an hour. */
const VOTES_PER_HOUR = { browser: 20, ip: 60 };

const fail = (error: string, status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  NextResponse.json({ error, ...extra }, { status, headers: { ...PRIVATE, ...headers } });

async function fresh(id: string) {
  const stored = (await readPoll(db(), id)) as StoredPoll | null;
  return stored ? (await publicPolls([stored]))[0] : null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!POLL_ID.test(id)) return fail("not_found", 404);
  await ensureSchema();
  const voter = await currentVoter({ create: false });
  const mine = voter ? await myVote(db(), { pollId: id, voter: voter.voter, browser: voter.browser }) : null;
  const poll = (await readPoll(db(), id)) as StoredPoll | null;
  if (!poll) return fail("not_found", 404);
  return NextResponse.json({ mine, open: poll.status === "active", turnstile: turnstileRequired() }, { headers: PRIVATE });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return fail("bad_origin", 403);
  const { id } = await params;
  if (!POLL_ID.test(id)) return fail("not_found", 404);
  let body: { option?: unknown; turnstileToken?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", 400);
  }
  const option = body?.option;
  if (typeof option !== "number" || !Number.isInteger(option) || option < 0 || option > 9) return fail("bad_request", 400);

  await ensureSchema();
  const voter = (await currentVoter({ create: true }))!;
  const ip = clientIp(req);
  const now = Date.now();
  const limits = [rateLimit(db(), `poll-vote:b:${voter.browser}`, { limit: VOTES_PER_HOUR.browser, windowMs: HOUR, now })];
  if (ip) limits.push(rateLimit(db(), `poll-vote:ip:${ipKey(ip)}`, { limit: VOTES_PER_HOUR.ip, windowMs: HOUR, now }));
  const hits = await Promise.all(limits);
  const over = hits.find((h) => !h.ok);
  if (over) return fail("rate_limited", 429, {}, { "retry-after": String(over.retryAfterSec) });

  const check = await verifyTurnstile(body.turnstileToken, ip);
  if (check === "failed") return fail("turnstile_failed", 403);

  const out = await castVote(db(), { pollId: id, option, voter: voter.voter, browser: voter.browser, now: new Date(now) });
  if (out.ok) return NextResponse.json({ mine: out.mine, poll: await fresh(id) }, { headers: PRIVATE });
  switch (out.error) {
    case "already_voted":
      return fail("already_voted", 409, { mine: out.mine, poll: await fresh(id) });
    case "closed":
      return fail("closed", 410);
    case "bad_option":
      return fail("bad_option", 400);
    default:
      return fail("not_found", 404);
  }
}
