import type { Profile } from "./profile";
import { tierLabel } from "./tiers.mjs";

// What search engines read about a profile (docs/BOTS-AND-SEO.md, "Profile
// pages"): its description, built from the grade and the rank, and its
// structured data, a ProfilePage about the person. Only for indexable
// profiles (graded real portfolios); the rest say noindex. Nothing here is
// shown on the page itself.

/** Search results cut descriptions at about this many characters. */
export const DESCRIPTION_MAX = 160;

type SeoProfile = Pick<Profile, "name" | "url" | "domain" | "tagline" | "tier" | "standing" | "report" | "socials">;

/** The tier and the share it beats, once it's a real letter (not the starting one while face-offs are under way). */
function rankLine(p: SeoProfile): string | null {
  if (!p.tier || p.standing.provisional) return null;
  const { top, of } = p.standing;
  const among = of != null ? ` of ${of.toLocaleString("en-US")} ranked portfolios` : " of ranked portfolios";
  return top != null ? `Tier ${tierLabel(p.tier)}, top ${top}%${among} on PortfolioRank.` : `Tier ${tierLabel(p.tier)} on PortfolioRank.`;
}

/** The AI review's best criteria (4 or 5 out of 5), best first, at most two. */
function strengths(p: SeoProfile): string | null {
  const best = [...(p.report?.axes ?? [])].filter((a) => a.score >= 4).sort((a, b) => b.score - a.score).slice(0, 2);
  if (!best.length) return null;
  return `Strongest in the AI review: ${best.map((a) => `${a.label.toLowerCase()} (${a.score}/5)`).join(" and ")}.`;
}

/** Cut at a word boundary with an ellipsis. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2)).replace(/[\s,.;:]+$/, "")}…`;
}

/**
 * About 150 characters from the data: who and what (the grade's roles), the
 * tier and where it ranks, the review's strongest criteria, then the
 * person's own tagline, each added while it fits.
 */
export function profileDescription(p: SeoProfile): string {
  const roles = p.report?.roles ?? [];
  const kind = roles.length ? `${roles.slice(0, 2).join(" and ")} portfolio` : "developer portfolio";
  const parts = [`${p.name}'s ${kind} at ${p.domain}.`, rankLine(p), strengths(p), p.tagline ? `“${p.tagline.trim().replace(/[.\s]+$/, "")}.”` : null];
  let out = "";
  for (const part of parts) {
    if (!part) continue;
    if (!out) out = part;
    else if (out.length + 1 + part.length <= DESCRIPTION_MAX) out = `${out} ${part}`;
  }
  return clip(out, DESCRIPTION_MAX);
}

/** "frontend developer" -> "Frontend Developer". */
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * The ProfilePage node (https://developers.google.com/search/docs/appearance/structured-data/profile-page):
 * the person, their site, and the profiles it links to (GitHub, LinkedIn, X) when known.
 */
export function profilePageLd(p: SeoProfile, { canonical, title, siteUrl, siteName }: { canonical: string; title: string; siteUrl: string; siteName: string }) {
  const sameAs = [p.url, p.socials.github, p.socials.linkedin, p.socials.x].filter((u): u is string => Boolean(u));
  const role = p.report?.roles[0];
  return {
    "@type": "ProfilePage",
    "@id": canonical,
    url: canonical,
    name: title,
    description: profileDescription(p),
    inLanguage: "en",
    isPartOf: { "@type": "WebSite", name: siteName, url: siteUrl },
    mainEntity: {
      "@type": "Person",
      "@id": `${canonical}#person`,
      name: p.name,
      url: p.url,
      sameAs: [...new Set(sameAs)],
      ...(role ? { jobTitle: titleCase(role) } : {}),
      ...(p.tagline ? { description: p.tagline } : {}),
    },
  };
}
