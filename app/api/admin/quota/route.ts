import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { DEFAULT_PLAN, QUOTA_TZ, STAGES, backgroundAllowance, budgetPlan, peopleAllowance, reserveFor, usageHistory, usageToday } from "@/pipeline/budget.mjs";
import { dailyQuota } from "@/pipeline/gemini-log.mjs";
import { parkedItems, recentNights } from "@/pipeline/night.mjs";
import { activeAlerts } from "@/pipeline/alerts.mjs";
import { creditUsage, monthlyCap } from "@/lib/content/tavily-credits.mjs";
import { pexelsCap, searchUsage } from "@/lib/content/pexels-searches.mjs";
import { aiLimits, aiUsage } from "@/lib/content/neurons.mjs";
import { librarySummary } from "@/lib/content/library.mjs";
import { modelWatchSummary } from "@/pipeline/model-watch.mjs";

// The admin quota view's data (no page yet; the redesign's admin page reads
// it): Gemini use by job and model for today's quota day and the last 30,
// what each background stage and people may spend right now, the latest
// end-of-day runs, the parked items, the owner alerts that hold, people's
// queued requests, the weekly model watch's latest report, and the monthly
// Tavily credits and Pexels searches, today's AI images (and neurons) and the
// image library's counts. Read-only, and only for the GitHub login in
// ADMIN_GITHUB_LOGIN.
//   GET /api/admin/quota[?days=30]
export const dynamic = "force-dynamic";

const PRIVATE = { "cache-control": "private, no-store" };

// A table that doesn't exist yet (no request logged, no night run) reads as empty.
async function orEmpty<T>(read: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (/no such table/i.test(String((e as Error)?.message))) return empty;
    throw e;
  }
}

export async function GET(req: Request) {
  const who = await requireAdmin();
  if ("error" in who) {
    return NextResponse.json({ error: who.error }, { status: who.error === "signin_required" ? 401 : 403, headers: PRIVATE });
  }
  await ensureSchema();
  const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get("days")) || 30, 1), 90);
  const now = new Date();
  const plan = budgetPlan(process.env.GEMINI_BUDGET);
  const quota = dailyQuota(process.env.GEMINI_DAILY_QUOTA);
  const client = db();
  const emptyUsage = { day: "", start: "", end: "", byModel: {}, byJob: {}, peopleLastHour: 0, peopleRecent: 0 };
  const [history, usage, nights, parked, alerts, peopleQueue, modelWatch, tavily, pexels, aiImages, library] = await Promise.all([
    orEmpty(() => usageHistory(client, { now, days, quota }), null),
    orEmpty(() => usageToday(client, { now, plan }), emptyUsage),
    orEmpty(() => recentNights(client, { limit: 14 }), []),
    orEmpty(() => parkedItems(client), []),
    orEmpty(() => activeAlerts(client), []),
    orEmpty(
      async () =>
        Object.fromEntries((await client.execute("SELECT status, COUNT(*) AS n FROM people_requests GROUP BY status")).rows.map((r) => [String(r.status), Number(r.n)])),
      {}
    ),
    orEmpty(() => modelWatchSummary(client), { latest: null, runs: [] }),
    // Tavily credits used this month against the cap (200 of the shared 1,000).
    orEmpty(() => creditUsage(client, { cap: monthlyCap(process.env.TAVILY_MONTHLY_CREDITS), now }), { month: "", used: 0, cap: monthlyCap(process.env.TAVILY_MONTHLY_CREDITS) }),
    // Pexels searches this month (free; the cap only stops a runaway).
    orEmpty(() => searchUsage(client, { cap: pexelsCap(process.env.PEXELS_MONTHLY_SEARCHES), now }), { month: "", used: 0, cap: pexelsCap(process.env.PEXELS_MONTHLY_SEARCHES) }),
    // AI images today ("N of 40") and their neurons, the never-pay guard (lib/content/neurons.mjs).
    orEmpty(() => aiUsage(client, { limits: aiLimits(process.env), now }), null),
    // The image library: images by status and queue items left (/admin/images).
    orEmpty(() => librarySummary(client), null),
  ]);
  return NextResponse.json(
    {
      timezone: QUOTA_TZ,
      model: plan.model,
      quota,
      plan: { reserve: plan.reserve, demandFactor: plan.demandFactor, batch: plan.batch, start: `${plan.startHour}:${String(plan.startMinute).padStart(2, "0")}`, stages: plan.stages, defaults: DEFAULT_PLAN.stages },
      now: {
        day: usage.day,
        used: usage.byModel,
        peopleLastHour: usage.peopleLastHour,
        reserve: reserveFor(usage, plan),
        people: peopleAllowance(usage, { plan, quota, now }),
        // "AI ranking comparisons" is Gemini comparing sites; human face-off votes use no Gemini.
        background: STAGES.map((s) => ({ key: s.key, job: s.job, label: s.label, ...backgroundAllowance(s.key, usage, { plan, quota }) })),
      },
      today: history?.today ?? null,
      days: history?.days ?? [],
      nights,
      parked,
      alerts,
      peopleQueue,
      modelWatch,
      tavily,
      pexels,
      // { day, images, maxImages, neurons, ceiling, slice, free, problem }: "AI images today: N of 40";
      // problem names a rejected setting (Workers AI is off until it is fixed).
      aiImages,
      library,
    },
    { headers: PRIVATE }
  );
}
