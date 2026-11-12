import { db, ensureSchema } from "@/lib/db";
import { DEFAULT_PLAN, QUOTA_TZ, STAGES, backgroundAllowance, budgetPlan, peopleAllowance, reserveFor, usageHistory, usageToday } from "@/pipeline/budget.mjs";
import { dailyQuota } from "@/pipeline/gemini-log.mjs";
import { parkedItems, recentNights } from "@/pipeline/night.mjs";
import { activeAlerts } from "@/pipeline/alerts.mjs";
import { creditUsage, monthlyCap } from "@/lib/content/tavily-credits.mjs";
import { pexelsCap, searchUsage } from "@/lib/content/pexels-searches.mjs";
import { aiLimits, aiUsage } from "@/lib/content/neurons.mjs";
import { librarySummary } from "@/lib/content/library.mjs";
import { modelWatchSummary } from "@/pipeline/model-watch.mjs";
import { freshnessSummary } from "@/lib/freshness.mjs";
import { ACTIVE } from "@/pipeline/roster.mjs";

// What the site spends of its free allowances, read once for both
// GET /api/admin/quota (JSON) and the /admin/usage page: Gemini use by quota
// day, job and model for today and the last `days`, what each background
// stage and people may spend right now, the latest end-of-day runs, parked
// items, the owner alerts that hold, people's queued requests and the
// grader's waiting jobs, the weekly model watch, the monthly Tavily credits
// and Pexels searches, today's AI images (and neurons) and the image
// library's counts, and when checks re-ran (sites unchanged, changed this
// week, re-measured today; lib/freshness.mjs). Read-only; no metered call.

// A table that doesn't exist yet (no request logged, no night run) reads as empty.
async function orEmpty<T>(read: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (/no such table/i.test(String((e as Error)?.message))) return empty;
    throw e;
  }
}

const countBy = async (sql: string) =>
  Object.fromEntries((await db().execute(sql)).rows.map((r) => [String(r.status), Number(r.n)])) as Record<string, number>;

export async function adminUsage({ days = 30, now = new Date() }: { days?: number; now?: Date } = {}) {
  await ensureSchema();
  const plan = budgetPlan(process.env.GEMINI_BUDGET);
  const quota = dailyQuota(process.env.GEMINI_DAILY_QUOTA) as Record<string, number>;
  const client = db();
  const emptyUsage = { day: "", start: "", end: "", byModel: {}, byJob: {}, peopleLastHour: 0, peopleRecent: 0 };
  const tavilyCap = monthlyCap(process.env.TAVILY_MONTHLY_CREDITS);
  const pexelsMax = pexelsCap(process.env.PEXELS_MONTHLY_SEARCHES);
  const [history, usage, nights, parked, alerts, peopleQueue, gradeJobs, modelWatch, tavily, pexels, aiImages, library, freshness] = await Promise.all([
    orEmpty(() => usageHistory(client, { now, days, quota }), null),
    orEmpty(() => usageToday(client, { now, plan }), emptyUsage),
    orEmpty(() => recentNights(client, { limit: 14 }), []),
    orEmpty(() => parkedItems(client), []),
    orEmpty(() => activeAlerts(client), []),
    orEmpty(() => countBy("SELECT status, COUNT(*) AS n FROM people_requests GROUP BY status"), {}),
    // The grader's jobs still on their way (lib/grader/jobs.mjs ACTIVE_STATES).
    orEmpty(() => countBy("SELECT status, COUNT(*) AS n FROM grade_jobs WHERE status IN ('capturing', 'waiting', 'grading', 'queued', 'awaiting_key') GROUP BY status"), {}),
    orEmpty(() => modelWatchSummary(client), { latest: null, runs: [] }),
    // Tavily credits used this month against the cap (200 of the shared 1,000).
    orEmpty(() => creditUsage(client, { cap: tavilyCap, now }), { month: "", used: 0, cap: tavilyCap }),
    // Pexels searches this month (free; the cap only stops a runaway).
    orEmpty(() => searchUsage(client, { cap: pexelsMax, now }), { month: "", used: 0, cap: pexelsMax }),
    // AI images today ("N of 40") and their neurons, the never-pay guard (lib/content/neurons.mjs).
    orEmpty(() => aiUsage(client, { limits: aiLimits(process.env), now }), null),
    // The image library: images by status and queue items left (/admin/images).
    orEmpty(() => librarySummary(client), null),
    // When checks re-run (lib/freshness.mjs): sites unchanged, changed this week, re-measured today.
    orEmpty(() => freshnessSummary(client, { now: now.getTime(), active: ACTIVE }), null),
  ]);
  return {
    timezone: QUOTA_TZ,
    model: plan.model as string,
    quota,
    plan: { reserve: plan.reserve, demandFactor: plan.demandFactor, batch: plan.batch, start: `${plan.startHour}:${String(plan.startMinute).padStart(2, "0")}`, stages: plan.stages, defaults: DEFAULT_PLAN.stages },
    now: {
      day: usage.day as string,
      used: usage.byModel as Record<string, number>,
      peopleLastHour: usage.peopleLastHour as number,
      reserve: reserveFor(usage, plan) as number,
      people: peopleAllowance(usage, { plan, quota, now }) as number,
      // "AI ranking comparisons" is Gemini comparing sites; human face-off votes use no Gemini.
      background: STAGES.map((s) => ({ key: s.key as string, job: s.job as string, label: s.label as string, ...backgroundAllowance(s.key, usage, { plan, quota }) })) as {
        key: string;
        job: string;
        label: string;
        allowed: number;
        remaining: number;
        reserve: number;
        used: number;
        cap: number;
        limitedBy: "cap" | "quota" | null;
      }[],
    },
    today: (history?.today ?? null) as UsageDay | null,
    days: (history?.days ?? []) as UsageDay[],
    nights,
    parked,
    alerts,
    peopleQueue,
    gradeJobs,
    modelWatch,
    tavily,
    pexels,
    // { day, images, maxImages, neurons, ceiling, slice, free, problem }: "AI images today: N of 40";
    // problem names a rejected setting (Workers AI is off until it is fixed).
    aiImages,
    library,
    // { unchanged, changedThisWeek, unchecked, checkedToday, remeasuredToday: { lighthouse, polish, screenshots, links, total } }
    freshness,
  };
}

export type UsageDay = { day: string; total: Record<string, number>; jobs: { job: string; label: string; model: string; requests: number; ok: number }[] };
export type AdminUsage = Awaited<ReturnType<typeof adminUsage>>;
