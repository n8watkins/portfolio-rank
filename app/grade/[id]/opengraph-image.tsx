import { OG_SIZE } from "@/lib/og-card";
import { portfolioCard } from "@/lib/og-portfolio";
import { db, ensureSchema } from "@/lib/db";
import { JOB_ID, readJob } from "@/lib/grader/jobs.mjs";
import { displayName } from "@/lib/grader/present.mjs";
import { graderEnabled, readGradeShot } from "@/lib/grader/server";
import { listedSite } from "@/lib/me";
import { isPublicTier } from "@/lib/tiers.mjs";

/** The public tiers (SSS to B-) are the top 70% (lib/tiers.mjs): a "top N%" past that stays off the card. */
const PUBLIC_TOP_PCT = 70;

// A grade report's share card: the shared portfolio card (lib/og-portfolio.tsx)
// with the person's name, address, screenshot, tier and "Top N%". Like the
// report it is reached only through the report's id; a missing, deleted or
// unfinished report gets a plain card that names nothing. Like every report
// answer it is never kept in a shared cache, so a deleted report's card goes
// with it.

export const alt = "A PortfolioRank grade report";
export const size = OG_SIZE;
export const contentType = "image/png";

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** The address as people type it: no scheme, no www, no trailing slash. */
const shownUrl = (url: string) => url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");

async function report(id: string) {
  if (!graderEnabled() || !JOB_ID.test(id)) return null;
  await ensureSchema();
  const job = await readJob(db(), id);
  if (!job || job.status !== "done" || !job.result) return null;
  const url = String(job.url);
  const quick = job.quick as { title?: string } | null;
  const name = displayName({ listedName: listedSite(String(job.site_key))?.name, title: quick?.title, domain: domainOf(url) });
  const shot = job.shot_key ? await readGradeShot(String(job.shot_key), "hero.jpg").catch(() => null) : null;
  // The tier by rank (lib/tiers.mjs) and "Top N%" show on the card only for the public tiers (SSS to B):
  // the card travels with the link, so no one's shared card says C or D. Letters
  // show from day one (lib/tiers.mjs, #210); without one, the result shows when
  // it is in the public tiers' range (the top 70%).
  const rank = job.report?.rank ?? null;
  const tier = rank?.tier;
  const pct = (job.report?.percentile ?? null) as { topPct: number; total: number } | null;
  const result = pct ? { topPct: pct.topPct, total: pct.total - 1 } : null;
  if (!tier) return { name, url: shownUrl(url), shot, tier: null, result: result && result.topPct <= PUBLIC_TOP_PCT ? result : null };
  if (!isPublicTier(tier)) return { name, url: shownUrl(url), shot, tier: null, result: null };
  return { name, url: shownUrl(url), shot, tier: String(tier), result };
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await report(id);
  return portfolioCard(r ?? { name: "Grade report", url: "How good is your portfolio?", shot: null, tier: null, result: null }, {
    "cache-control": "private, max-age=300",
    "x-robots-tag": "noindex",
  });
}
