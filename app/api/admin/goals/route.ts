import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { GOALS } from "@/lib/goals/config.mjs";
import { checkGoals, goalsHistory } from "@/pipeline/goals.mjs";

// The owner's goals as JSON (lib/goals/config.mjs, pipeline/goals.mjs), for
// an admin "Goals" page (n8builds admin, later). Read-only, and only for the
// GitHub account in ADMIN_GITHUB_ID.
//   GET /api/admin/goals -> { now, week, goals: [{ id, title, why, meeting,
//     reached, conditions: [{ metric, label, atLeast, weeks, values, met }],
//     history: [{ week, checkedAt, metrics, reached }] (last 12 weeks, newest
//     first), event: null | { reachedAt, week, met, slotStart, notifiedAt,
//     lastError }, preview?: { subject, text, slot, attachments } }] }
// "conditions" are measured now, for the last finished week (a dry run of
// the weekly check: nothing is written or sent). "preview" is the email the
// next check would send, for a goal that is reached and not yet emailed.
export const dynamic = "force-dynamic";

const PRIVATE = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" };

export async function GET() {
  const who = await requireAdmin();
  if ("error" in who) return NextResponse.json({ error: who.error }, { status: who.error === "signin_required" ? 401 : 403, headers: PRIVATE });
  await ensureSchema();
  const client = db();
  const now = new Date();
  const [dry, history] = await Promise.all([
    checkGoals({ db: client, email: null, to: null, siteUrl: process.env.AUTH_URL ?? "" }, { now, dryRun: true }),
    goalsHistory(client),
  ]);
  const goals = GOALS.map((g) => {
    const live = dry.goals.find((x) => x.id === g.id)!;
    const past = history.find((x) => x.id === g.id)!;
    return {
      id: g.id,
      title: g.title,
      why: g.why,
      meeting: g.meeting,
      reached: live.reached,
      conditions: live.conditions,
      history: past.history,
      event: past.event,
      ...(live.email ? { preview: { subject: live.email.subject, text: live.email.text, slot: live.slot, attachments: live.email.attachments } } : {}),
    };
  });
  return NextResponse.json({ now: now.toISOString(), week: dry.week, goals }, { headers: PRIVATE });
}
