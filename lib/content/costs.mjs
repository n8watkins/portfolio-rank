// The cost panel on /admin/blog (docs/CONTENT-ENGINE.md, "Write a draft
// now"): what the blog may still spend today, read from the existing
// counters with no metered call. Gemini today (used, left, the reserve kept
// for people, and what a manual draft may take now), Tavily this month and
// this week, Pexels this month, AI images today, and manual drafts today.
import { backgroundAllowance, budgetPlan, reserveFor, usageToday } from "../../pipeline/budget.mjs";
import { dailyQuota } from "../../pipeline/gemini-log.mjs";
import { creditUsage, monthlyCap } from "./tavily-credits.mjs";
import { pexelsCap, searchUsage } from "./pexels-searches.mjs";
import { aiLimits, aiUsage } from "./neurons.mjs";
import { tavilyThisWeek } from "./store.mjs";
import { MANUAL_PER_DAY, jobsToday } from "./jobs.mjs";
import { TAVILY_PER_POST, TAVILY_PER_WEEK } from "../../pipeline/content/claims.mjs";
import { MANUAL_REQUESTS } from "../../pipeline/content/manual.mjs";

async function orNull(read) {
  try {
    return await read();
  } catch (e) {
    if (/no such table/i.test(String(e?.message))) return null;
    throw e;
  }
}

/**
 * Every number on the cost panel: { gemini, tavily, pexels, images, drafts }.
 * `env` is process.env (or the Worker's env).
 */
export async function contentCosts(db, { env = {}, now = new Date() } = {}) {
  const plan = budgetPlan(env.GEMINI_BUDGET);
  const quota = dailyQuota(env.GEMINI_DAILY_QUOTA);
  const usage = (await orNull(() => usageToday(db, { now, plan }))) ?? { byModel: {}, byJob: {}, peopleLastHour: 0, peopleRecent: 0 };
  const model = plan.model;
  const used = Number(usage.byModel?.[model] ?? 0);
  const total = Number(quota?.[model] ?? 0);
  const content = backgroundAllowance("content", usage, { plan, quota });
  const tavilyCap = monthlyCap(env.TAVILY_MONTHLY_CREDITS);
  const [tavily, week, pexels, images, drafts] = await Promise.all([
    orNull(() => creditUsage(db, { cap: tavilyCap, now })),
    orNull(() => tavilyThisWeek(db, now)),
    orNull(() => searchUsage(db, { cap: pexelsCap(env.PEXELS_MONTHLY_SEARCHES), now })),
    orNull(() => aiUsage(db, { limits: aiLimits(env), now })),
    orNull(() => jobsToday(db, { now })),
  ]);
  return {
    gemini: { model, used, total, left: Math.max(0, total - used), reserve: reserveFor(usage, plan), contentUsed: content.used, contentCap: content.cap, draftNow: Math.min(MANUAL_REQUESTS, content.allowed) },
    tavily: { used: tavily?.used ?? 0, cap: tavilyCap, week: week ?? 0, weekCap: TAVILY_PER_WEEK, perPost: TAVILY_PER_POST },
    pexels: { used: pexels?.used ?? 0, cap: pexels?.cap ?? pexelsCap(env.PEXELS_MONTHLY_SEARCHES), perPost: 2 },
    images: { used: images?.images ?? 0, cap: images?.maxImages ?? 0, neurons: images?.neurons ?? 0, ceiling: images?.ceiling ?? 0, perPost: 1 },
    drafts: { today: drafts ?? 0, cap: MANUAL_PER_DAY },
  };
}
