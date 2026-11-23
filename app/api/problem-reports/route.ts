import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { rateLimit } from "@/lib/polls/store.mjs";
import { clientIp, currentVoter, sameOrigin } from "@/lib/polls/server";
import { networkOf } from "@/lib/grader/caps.mjs";
import { keyed, readJsonBody } from "@/lib/grader/server";
import { isKnownPortfolio } from "@/lib/roster";
import { verifyTurnstile } from "@/lib/turnstile";
import { TURNSTILE_ACTION, takeReport } from "@/lib/problem-reports/intake.mjs";
import { siteOnRecord } from "@/lib/problem-reports/store.mjs";

// "Report a problem" from a profile (components/profile/ReportProblem.tsx):
// a visitor says the screenshot or a measurement is wrong, that it is not a
// portfolio or that the site is gone. No account needed.
//
// POST /api/problem-reports { url, reason, note?, turnstileToken? }
//   200 { ok: true }    stored (or the site already has a day's worth)
//   400 bad_request | bad_reason | bad_note | note_too_long
//   403 bad_origin | turnstile_failed
//   404 unknown_site    no profile for that address
//   429 rate_limited (Retry-After)
// The steps and limits are lib/problem-reports/intake.mjs's. The visitor and
// the network are stored only as keyed hashes. The owner reads the reports on
// /admin/review; a report changes nothing about the site by itself.
export const dynamic = "force-dynamic";

const PRIVATE = { "cache-control": "private, no-store" };

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403, headers: PRIVATE });
  const body = await readJsonBody(req, 4096);
  await ensureSchema();
  const client = db();
  const voter = (await currentVoter({ create: true }))!;
  const ip = clientIp(req);
  const net = networkOf(ip);
  const out = await takeReport({
    db: client,
    body,
    visitor: keyed("report-visitor", voter.voter),
    network: net ? keyed("report-network", net) : "",
    verify: (token: unknown) => verifyTurnstile(token, ip, { action: TURNSTILE_ACTION }),
    known: async (url: string) => isKnownPortfolio(url) || (await siteOnRecord(client, url)),
    rateLimit: (key: string, opts: { limit: number; windowMs: number; now: number }) => rateLimit(client, key, opts),
    now: Date.now(),
  });
  return NextResponse.json(out.body, { status: out.status, headers: { ...PRIVATE, ...(out.headers ?? {}) } });
}
