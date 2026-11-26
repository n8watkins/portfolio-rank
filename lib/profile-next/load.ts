import { cache } from "react";
import { db } from "@/lib/db";
import { loadProfile, type Profile } from "@/lib/profile";
import { freshFactsFor } from "@/lib/fresh-facts.mjs";
import { loadProfileTier } from "@/lib/tiers-view";
import { TIER_LADDER, tierLabel } from "@/lib/tiers.mjs";
import { fullPagePreview, heroOf, mobileOf, mshotsUrl, shotBases } from "@/lib/shots";
import { toolsEnabled } from "@/lib/tools/server";
import { gamesEnabled } from "@/lib/games/server";
import { psiKey } from "@/lib/tools/keys";
import { profileReport } from "./report.mjs";
import { claimCopy } from "./claim-copy.mjs";

// Everything the redesigned profile (app/p/[slug]/next) shows, read once per
// render (React cache: the page and its metadata share one load): the profile
// (lib/profile.ts), its tier and votes, the pictures of the site, the report
// made from the saved checks (./report.mjs) and what claiming offers
// (./claim-copy.mjs). Nothing here names who is looking, so the page is
// cached at the edge per site.

/** One picture of the site for the screenshots: a tall full-page image that pans, or the top screenful (a still). */
export type ShotView = { src: string; width: number; height: number; tall: boolean };

export type NextTier = {
  /** The tier letter as shown (a real minus sign), or null while tiers are not shown (RANKING_V2 off) or the site has none. */
  letter: string | null;
  /** The tier (SSS, S+ ... C-), which picks the badge. */
  tier: string | null;
  /** "Strong", "Solid"... */
  word: string | null;
  votes: number;
  elo: number;
  /** The starting rank came from the code measurements. */
  seeded: boolean;
  /** Tiers by ELO are shown at all (RANKING_V2). */
  tiersShown: boolean;
};

export type NextProfile = {
  p: Profile;
  tier: NextTier;
  shots: { desktop: ShotView; phone: ShotView | null; thumb: string };
  socials: { github: string | null; linkedin: string | null; x: string | null };
  report: ReturnType<typeof profileReport> | null;
  claim: ReturnType<typeof claimCopy>;
};

const parse = (v: unknown): Record<string, unknown> | null => {
  if (v == null || v === "") return null;
  if (typeof v === "object") return v as Record<string, unknown>;
  try {
    const o = JSON.parse(String(v));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
};

/** An https profile link scraped from the page, or null (a javascript: or http: link is never shown). */
const httpsLink = (v: unknown) => (typeof v === "string" && /^https:\/\//i.test(v) ? v : null);

/** A saved result and when it was saved (the cache row's `at`, ms), as lib/cache.ts stores it. */
type Saved = { v: Record<string, unknown> | null; at: number | null };

export const loadNextProfile = cache(async (url: string): Promise<NextProfile | null> => {
  const p = await loadProfile(url);
  if (!p || p.gone) return null;
  const client = db();
  const [row, rows, bases, full] = await Promise.all([
    client.execute({ sql: "SELECT ai_rubric, facts FROM portfolios WHERE url = ?", args: [url] }).then((r) => r.rows[0]),
    client.execute({ sql: "SELECT k, v, at FROM cache WHERE k IN (?, ?)", args: [`inspect:${url}`, psiKey("mobile", url)] }).then((r) => r.rows),
    shotBases([url]),
    fullPagePreview(url).catch(() => null),
  ]);
  const saved = (k: string): Saved => {
    const r = rows.find((x) => String(x.k) === k);
    return r ? { v: parse(r.v), at: Number.isFinite(Number(r.at)) ? Number(r.at) : null } : { v: null, at: null };
  };
  const grade = p.hideGrade ? null : parse(row?.ai_rubric);
  const t = await loadProfileTier(url, row?.ai_rubric ?? null, p.hideGrade);

  // The newest measured facts when they are at least as new a measuring version as the grade's copy (lib/fresh-facts.mjs);
  // an added site's from its free checks.
  const facts = freshFactsFor(grade, row?.facts) ?? parse(grade?.facts) ?? parse(row?.facts) ?? (p.saved.quick?.ok ? parse(p.saved.quick.facts) : null);
  const inspect = saved(`inspect:${url}`);
  const psi = saved(psiKey("mobile", url));
  const report = p.hideGrade ? null : profileReport({ url, inspect: inspect.v, facts, psi: psi.v, inspectAt: inspect.at, psiAt: psi.at });

  const base = bases.get(url);
  const desktop: ShotView = full
    ? { src: full.desktop.src, width: full.desktop.width, height: full.desktop.height, tall: full.desktop.height > full.desktop.topHeight }
    : { src: base ? heroOf(base) : mshotsUrl(url, 1200), width: 1440, height: 900, tall: false };
  const phone: ShotView | null = full
    ? { src: full.phone.src, width: full.phone.width, height: full.phone.height, tall: full.phone.height > full.phone.topHeight }
    : base
      ? { src: mobileOf(base), width: 390, height: 844, tall: false }
      : null;

  const ladder = t?.shown ? TIER_LADDER.find((x) => x.tier === t.shown) : null;
  const ins = inspect.v?.ok === true ? inspect.v : null;
  return {
    p,
    tier: {
      letter: t?.shown ? tierLabel(t.shown) : null,
      tier: t?.shown ?? null,
      word: ladder?.name ?? null,
      // With tiers shown (RANKING_V2) the tier's real votes; otherwise the ELO and votes today's profile shows (the ratings row).
      votes: t ? t.votes : p.standing.faceoffs,
      elo: t ? t.elo : p.standing.elo,
      seeded: Boolean(t?.seeded),
      tiersShown: t != null,
    },
    shots: { desktop, phone, thumb: full ? full.desktop.thumb : desktop.src },
    socials: ins ? { github: httpsLink(ins.githubUrl), linkedin: httpsLink(ins.linkedinUrl), x: httpsLink(ins.xUrl) } : { github: null, linkedin: null, x: null },
    report,
    claim: claimCopy({ tools: toolsEnabled(), games: gamesEnabled() }),
  };
});
