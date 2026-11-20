import { db, ensureSchema } from "@/lib/db";
import { heroOf, shotBases } from "@/lib/shots";
import { hiddenUrls } from "@/lib/roster";
import { gamesEnabled } from "@/lib/games/server";
import { ownedJobs } from "@/lib/grader/server";
import { readJob } from "@/lib/grader/jobs.mjs";
import { publicJob } from "@/lib/grader/view.mjs";
import { emailState } from "@/lib/grader/notify.mjs";
import { gradedPool } from "@/lib/grader/report.mjs";
import { siteKeyOf } from "@/lib/grader/url.mjs";
import { displayName, fixEffects, hiringGroups, placeIn, verdictOf } from "@/lib/grader/present.mjs";
import { listedSite, type Job } from "@/lib/me";
import { reportPath } from "@/lib/home";
import { atLeast, isPublicTier } from "@/lib/tiers.mjs";

// What the grade report page (app/grade/[id]) reads for one job: the public
// job (lib/grader/view.mjs, the same answer GET /api/grade/<id> gives), plus
// what the page shows around it: the listed portfolio it is about (if any),
// screenshots of the portfolios it points to, their place on the board, and
// the wording from lib/grader/present.mjs. Reports are unlisted: the id is
// the only key, and nothing here names the visitor.

type PoolSite = { url: string; name: string; mu: number; key: number | null; tier: string | null; top: number | null; place: number | null; of: number | null };
export type PageJob = Job & { mine: boolean; checks: (Job["checks"] & { title?: string }) | null };

export type BrokenLink = { url: string; kind: "broken" | "blocked"; status: number | null; reason: string; text: string | null; section: string | null };

/** `tier` is the site's current tier by ELO (lib/tiers.mjs); shown only when it is a public one. `rank` and `topPct` are its place by ELO, once it has enough face-offs. */
export type ShownSite = { url: string; name: string; domain: string; tier: string | null; path: string; hero: string | null; rank: number | null; topPct: number | null };

export type GradePage = {
  job: PageJob;
  /** The page's own name: the list's name, the page title, else the domain. */
  name: string;
  hero: string | null;
  /** The listed portfolio this grade is about, when it's on the list. */
  listed: { url: string; path: string } | null;
  /** GAMES_V2: claims and owner actions are open. */
  games: boolean;
  /** When this was read: what "re-grade available in N days" counts from. */
  at: number;
  /** The free checks in the hiring manager's three groups, for a job with no report (yet). */
  checks: ReturnType<typeof hiringGroups> | null;
  /**
   * The project links that failed, from the capture's check (else the free
   * checks'): each URL, why ("404 Not Found", "timed out after 8 s") and
   * where it is on the page. Empty for grades from before the details were kept.
   */
  brokenLinks: BrokenLink[];
  /** How many links the checks found broken, for grades from before the details were kept. */
  brokenCount: number;
  report: null | {
    verdict: string;
    groups: ReturnType<typeof hiringGroups>;
    fixes: { criterion: string; title: string; why: string; by: "ai" | "code"; effect: string | null }[];
    better: null | { site: ShownSite; label: string; yours: number; theirs: number; note: string };
    similar: ShownSite[];
  };
};

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** Sites whose grade the page must not show: removed by their owner or with the grade hidden, or down. */
async function gradeHiddenUrls(): Promise<Set<string>> {
  const out = new Set(await hiddenUrls());
  try {
    const rows = (await db().execute("SELECT url FROM portfolio_owner WHERE removed_at IS NOT NULL OR hide_grade = 1")).rows;
    for (const r of rows) out.add(String(r.url));
  } catch {}
  return out;
}

/** The note the AI wrote for one axis of a listed portfolio's grade (one row by primary key). */
async function axisNote(url: string, criterion: string): Promise<string> {
  const r = (await db().execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [url] })).rows[0];
  try {
    const g = JSON.parse(String(r?.ai_rubric ?? "null"));
    const note = g?.[criterion]?.note;
    return typeof note === "string" ? note : "";
  } catch {
    return "";
  }
}

/** The page's data for one grade, or null when there is no such report. */
export async function gradePage(id: string): Promise<GradePage | null> {
  await ensureSchema();
  const client = db();
  const raw = await readJob(client, id);
  if (!raw) return null;
  const [owned, emails] = await Promise.all([ownedJobs(), emailState(client, id)]);
  const job = publicJob(raw, { mine: owned.includes(id), emails }) as PageJob;
  const site = listedSite(String(raw.site_key));
  const title = job.checks?.ok && typeof job.checks.title === "string" ? job.checks.title : "";
  const name = displayName({ listedName: site?.name, title, domain: job.domain });
  let hero = job.shots?.hero ?? null;
  if (!hero && site) {
    const shots = await shotBases([site.url]);
    hero = shots.has(site.url) ? heroOf(shots.get(site.url)!) : null;
  }
  const freeChecks = job.checks?.ok ? hiringGroups((job.checks as { facts?: Parameters<typeof hiringGroups>[0] }).facts ?? []) : null;
  type LinkCheck = { broken?: number; failures?: BrokenLink[] } | null | undefined;
  const linkCheck = ((raw.facts as { project_links?: LinkCheck } | null)?.project_links ?? (raw.quick as { facts?: { project_links?: LinkCheck } } | null)?.facts?.project_links) ?? null;
  const brokenLinks = (linkCheck?.failures ?? []).filter((f) => f && typeof f.url === "string" && f.kind === "broken").slice(0, 10);
  const base = { brokenLinks, brokenCount: Number(linkCheck?.broken ?? 0), job, name, hero, listed: site ? { url: site.url, path: reportPath(site.url) } : null, games: gamesEnabled(), at: Date.now(), checks: freeChecks?.length ? freeChecks : null };
  if (!job.report || !raw.result) return { ...base, report: null };

  const rep = job.report;
  const selfKey = String(raw.site_key);
  const isSelf = (url: string) => {
    try {
      return siteKeyOf(url) === selfKey;
    } catch {
      return false;
    }
  };
  const [pool, hidden] = await Promise.all([gradedPool(client) as Promise<PoolSite[]>, gradeHiddenUrls()]);
  const shown = (s: { url: string }) => !hidden.has(s.url) && !isSelf(s.url);
  const similar = rep.similar.filter(shown).slice(0, 4);
  const betterGroup = rep.better.map((b) => ({ ...b, sites: b.sites.filter(shown) })).find((b) => b.sites.length > 0) ?? null;
  const urls = [...similar.map((s) => s.url), ...(betterGroup ? [betterGroup.sites[0].url] : [])];
  const shots = await shotBases([...new Set(urls)]);
  const place = (url: string) => placeIn(pool, url);
  const tierNow = new Map(pool.map((p) => [p.url, p.tier]));
  const toShown = (s: (typeof similar)[number]): ShownSite => ({
    ...s,
    // Today's tier, not the one stored with the report (older reports stored Gemini's letter).
    tier: tierNow.get(s.url) ?? null,
    domain: s.domain || domainOf(s.url),
    hero: shots.has(s.url) ? heroOf(shots.get(s.url)!) : null,
    // Another person's place shows with a public tier only (lib/tiers.mjs PUBLIC_TIERS).
    rank: isPublicTier(tierNow.get(s.url)) ? (place(s.url)?.rank ?? null) : null,
    topPct: isPublicTier(tierNow.get(s.url)) ? (place(s.url)?.topPct ?? null) : null,
  });

  let better: NonNullable<GradePage["report"]>["better"] = null;
  if (betterGroup) {
    const s = betterGroup.sites[0];
    better = { site: toShown(s), label: betterGroup.label, yours: betterGroup.yours, theirs: 5, note: await axisNote(s.url, betterGroup.criterion) };
  }

  return {
    ...base,
    report: {
      // The report card's line follows the grade itself (Gemini's letter), not the tier by ELO.
      verdict: verdictOf(String((raw.result as { tier?: unknown } | null)?.tier ?? "")),
      groups: hiringGroups(rep.facts),
      fixes: fixEffects(raw.result, rep.fixes, pool, { isSelf }),
      better,
      similar: similar.map(toShown),
    },
  };
}

/** Two listed portfolios with screenshots, for the face-off card while a grade runs. */
export async function faceOffPair(): Promise<{ url: string; domain: string; hero: string }[]> {
  try {
    await ensureSchema();
    const pool = (await gradedPool(db())) as PoolSite[];
    const hidden = await gradeHiddenUrls();
    // The A family or better (the top 30% by ELO, lib/tiers.mjs); while few have enough face-offs, the best grades.
    const shown = pool.filter((p) => !hidden.has(p.url));
    const strong = shown.filter((p) => atLeast(p.tier, "A"));
    const pick = strong.length >= 12 ? strong : [...shown].sort((a, b) => b.mu - a.mu).slice(0, 40);
    for (let i = pick.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pick[i], pick[j]] = [pick[j], pick[i]];
    }
    const sample = pick.slice(0, 12).map((p) => p.url);
    const shots = await shotBases(sample);
    return sample
      .filter((u) => shots.has(u))
      .slice(0, 2)
      .map((u) => ({ url: u, domain: domainOf(u), hero: heroOf(shots.get(u)!) }));
  } catch {
    return [];
  }
}
