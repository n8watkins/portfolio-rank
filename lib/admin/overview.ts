import { db, ensureSchema } from "@/lib/db";
import { subscriberCount } from "@/lib/newsletter/server";
import { budgetPlan, usageToday } from "@/pipeline/budget.mjs";
import { dailyQuota } from "@/pipeline/gemini-log.mjs";

// The headline numbers on the /admin overview, one small read per card:
// Gemini requests today against the main model's daily allowance, the image
// library's pending and approved images, the blog's drafts waiting and
// published posts, the polls from this week on (and whether one is open),
// and the newsletter's confirmed subscribers (Kit's count, cached a day,
// lib/newsletter/server.ts). Each is null when its table doesn't exist yet;
// the newsletter's null also means the newsletter isn't built into this
// deploy, so the overview leaves its link out. Read-only; no metered call.

async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (e) {
    if (/no such table/i.test(String((e as Error)?.message))) return null;
    throw e;
  }
}

const countBy = async (sql: string, args: string[] = []) => {
  const rows = (await db().execute({ sql, args })).rows;
  return Object.fromEntries(rows.map((r) => [String(r.k), Number(r.n)])) as Record<string, number>;
};

export async function adminOverview({ now = new Date() }: { now?: Date } = {}) {
  await ensureSchema();
  const client = db();
  const plan = budgetPlan(process.env.GEMINI_BUDGET);
  const quota = dailyQuota(process.env.GEMINI_DAILY_QUOTA) as Record<string, number>;
  const model = plan.model as string;
  const at = now.toISOString();
  const [usage, images, posts, polls, newsletter] = await Promise.all([
    orNull(() => usageToday(client, { now, plan })),
    orNull(() => countBy("SELECT status AS k, COUNT(*) AS n FROM image_library GROUP BY status")),
    orNull(() => countBy("SELECT status AS k, COUNT(*) AS n FROM posts GROUP BY status")),
    orNull(() => countBy("SELECT CASE WHEN opens_at <= ? THEN 'open' ELSE 'upcoming' END AS k, COUNT(*) AS n FROM polls WHERE closes_at > ? GROUP BY k", [at, at])),
    orNull(async () => {
      await db().execute("SELECT 1 FROM newsletter_issues LIMIT 1");
      const k = await subscriberCount();
      return { count: k.count, connected: k.error !== "no_kit_key" };
    }),
  ]);
  return {
    gemini: { model, used: Number((usage?.byModel as Record<string, number> | undefined)?.[model] ?? 0), quota: quota[model] ?? 0 },
    images: images && { pending: images.pending ?? 0, approved: images.approved ?? 0 },
    blog: posts && { drafts: posts.draft ?? 0, published: posts.published ?? 0 },
    polls: polls && { open: polls.open ?? 0, upcoming: polls.upcoming ?? 0 },
    // confirmed is null while Kit isn't set up or didn't answer.
    newsletter: newsletter && { confirmed: newsletter.count, connected: newsletter.connected },
  };
}

export type AdminOverview = Awaited<ReturnType<typeof adminOverview>>;
