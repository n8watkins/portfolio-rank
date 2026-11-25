import { db } from "@/lib/db";
import { loadProfile, type Profile } from "@/lib/profile";
import { checkSources } from "@/lib/tiers-store.mjs";
import { freshFactsFor } from "@/lib/fresh-facts.mjs";
import { loadProfileTier } from "@/lib/tiers-view";
import { TIER_LADDER, tierLabel } from "@/lib/tiers.mjs";
import { fullPagePreview, heroOf, mobileOf, mshotsUrl, shotBases } from "@/lib/shots";
import { profileReport } from "./report.mjs";

// Everything the redesigned profile (app/p/[slug]/next) shows, read once per
// render: the profile (lib/profile.ts), its tier and votes, the pictures of
// the site and the report made from the saved checks (./report.mjs). Nothing
// here names who is looking, so the page is cached at the edge per site.

/** One picture of the site for the screenshots: a tall full-page image that pans, or the top screenful (a still). */
export type ShotView = { src: string; width: number; height: number; tall: boolean };

export type NextTier = {
  /** The tier letter as shown (a real minus sign), or null while tiers are not shown or the site has none. */
  letter: string | null;
  /** Its family (S, A, B, C, D), which colours the badge. */
  tier: string | null;
  /** "Strong", "Solid"... */
  word: string | null;
  votes: number;
  elo: number;
  /** The starting rank came from the code measurements. */
  seeded: boolean;
};

export type NextProfile = {
  p: Profile;
  tier: NextTier;
  shots: { desktop: ShotView; phone: ShotView | null; thumb: string };
  socials: { github: string | null; linkedin: string | null; x: string | null };
  report: ReturnType<typeof profileReport> | null;
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

export async function loadNextProfile(url: string): Promise<NextProfile | null> {
  const p = await loadProfile(url);
  if (!p || p.gone) return null;
  const client = db();
  const [row, sources, bases, full] = await Promise.all([
    client.execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [url] }).then((r) => r.rows[0]),
    checkSources(client, { only: url })
      .then((s) => s.get(url) ?? null)
      .catch(() => null),
    shotBases([url]),
    fullPagePreview(url).catch(() => null),
  ]);
  const grade = p.hideGrade ? null : parse(row?.ai_rubric);
  const t = await loadProfileTier(url, row?.ai_rubric ?? null, p.hideGrade);

  // The newest measured facts when they are at least as new a measuring version as the grade's copy (lib/fresh-facts.mjs).
  const facts = freshFactsFor(grade, sources?.facts) ?? parse(grade?.facts) ?? parse(sources?.facts) ?? (p.saved.quick?.ok ? parse(p.saved.quick.facts) : null);
  const inspect = parse(sources?.inspect);
  const psi = parse(sources?.psi) ?? p.saved.mobile;
  const report = p.hideGrade ? null : profileReport({ url, inspect, facts, psi });

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
  return {
    p,
    tier: {
      letter: t?.shown ? tierLabel(t.shown) : null,
      tier: t?.shown ?? null,
      word: ladder?.name ?? null,
      votes: t ? t.votes : p.standing.faceoffs,
      elo: t ? t.elo : p.standing.elo,
      seeded: Boolean(t?.seeded),
    },
    shots: { desktop, phone, thumb: full ? full.desktop.thumb : desktop.src },
    socials: inspect?.ok === true ? { github: httpsLink(inspect.githubUrl), linkedin: httpsLink(inspect.linkedinUrl), x: httpsLink(inspect.xUrl) } : { github: null, linkedin: null, x: null },
    report,
  };
}
