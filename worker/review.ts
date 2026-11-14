// The owner's rule for the review queue (lib/reviews/store.mjs
// autoApplyReviews), on the hourly Cron Trigger (worker/index.ts), only with
// REVIEW_AUTO_APPLY (lib/reviews/flag.ts): every pending row that passes
// (both models say it is a portfolio and no code rule objects) is applied
// through the same paths as the owner's Confirm and shown on /admin/review
// with Undo. Rows that fail, disagree, or were blocked wait for the owner.
// The profiles it changed leave the edge cache. Plain code, no Gemini.
import feed from "../data/feed.json";
import { db as database, ensureSchema } from "../lib/db";
import { autoApplyReviews } from "../lib/reviews/store.mjs";
import { profileTag } from "./edge-cache";
export { reviewAutoApplyEnabled } from "../lib/reviews/flag";

const listed = new Set((feed as { url: string }[]).map((p) => p.url));
const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));

export async function reviewAutoApplyTick(scheduledTime: number, { purgeTags }: { purgeTags?: (tags: string[]) => Promise<unknown> } = {}) {
  await ensureSchema();
  const results = await autoApplyReviews(database(), { onFeed: (url: string) => listed.has(url), now: new Date(scheduledTime) });
  const applied = results.filter((r) => r.ok).map((r) => r.url as string);
  if (applied.length && purgeTags) await purgeTags(applied.map(profileTag));
  log("review.auto_apply", { applied: applied.length, failed: results.filter((r) => !r.ok).map((r) => ({ id: r.id, error: r.error })) });
  return results;
}
