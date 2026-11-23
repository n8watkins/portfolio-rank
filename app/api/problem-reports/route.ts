import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { rateLimit } from "@/lib/polls/store.mjs";
import { clientIp, currentVoter, sameOrigin } from "@/lib/polls/server";
import { network48Of, networkOf } from "@/lib/grader/caps.mjs";
import { keyed, readJsonBody } from "@/lib/grader/server";
import { isGone, isKnownPortfolio } from "@/lib/roster";
import { ownerState } from "@/lib/games/claims.mjs";
import { toolsEnabled } from "@/lib/tools/server";
import { loadProfile } from "@/lib/profile";
import { logWarn, type LogFields } from "@/lib/log";
import { verifyTurnstile } from "@/lib/turnstile";
import { reconcileAlerts } from "@/pipeline/alerts.mjs";
import { CAP_ALERT_KEY, TURNSTILE_ACTION, UNKNOWN_NETWORK, takeReport } from "@/lib/problem-reports/intake.mjs";

// "Report a problem" from a profile (components/profile/ReportProblem.tsx):
// a visitor says the screenshot or a measurement is wrong, that it is not a
// portfolio or that the site is gone. No account needed.
//
// POST /api/problem-reports { url, reason, note?, turnstileToken? }
//   200 { ok: true }    stored (or a resend replaced the visitor's open
//                       report, or a day's cap was reached: nothing stored)
//   400 bad_request | bad_reason | bad_note | note_too_long
//   403 bad_origin | turnstile_failed
//   404 unknown_site    no live profile at that address
//   429 rate_limited (Retry-After)
// The steps and limits are lib/problem-reports/intake.mjs's. The visitor and
// the network are stored only as hashes keyed with the server's secret. The
// owner reads the reports on /admin/review; a report changes nothing about
// the site by itself.
export const dynamic = "force-dynamic";

const PRIVATE = { "cache-control": "private, no-store" };

/**
 * Whether /p/<url> shows a profile: the same checks the profile pages make
 * before answering 404 (app/p/[slug]/page.tsx and ./profile-v2.tsx). So an
 * address that only waits for a capture in `portfolios`, a site that stopped
 * working or one its owner removed is not "known".
 */
async function liveProfile(url: string): Promise<boolean> {
  if (toolsEnabled()) {
    const p = await loadProfile(url);
    return Boolean(p && !p.gone);
  }
  if (!isKnownPortfolio(url) || (await isGone(url))) return false;
  return !(await ownerState(db(), url, { fresh: true })).removedAt;
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403, headers: PRIVATE });
  const body = await readJsonBody(req, 4096);
  await ensureSchema();
  const client = db();
  const voter = (await currentVoter({ create: true }))!;
  const ip = clientIp(req);
  const net48 = network48Of(ip);
  const out = await takeReport({
    db: client,
    body,
    visitor: keyed("report-visitor", voter.voter),
    // No address (no cf-connecting-ip): one shared bucket, as the newsletter's, never no limit.
    network: keyed("report-network", networkOf(ip) || ip || UNKNOWN_NETWORK),
    network48: net48 ? keyed("report-network48", net48) : "",
    verify: (token: unknown) => verifyTurnstile(token, ip, { action: TURNSTILE_ACTION }),
    known: liveProfile,
    rateLimit: (key: string, opts: { limit: number; windowMs: number; now: number }) => rateLimit(client, key, opts),
    log: (fields: LogFields) => logWarn(fields),
    alert: async (condition: { key: string; kind: string; title: string; detail: string; quiet: boolean }) => {
      await reconcileAlerts(client, { conditions: [condition], scope: (key: string) => key === CAP_ALERT_KEY });
    },
    now: Date.now(),
  });
  return NextResponse.json(out.body, { status: out.status, headers: { ...PRIVATE, ...(out.headers ?? {}) } });
}
