import type { ReportCard } from "./profile";

// What search engines read about a profile (docs/BOTS-AND-SEO.md, "Profile
// pages"): whether to index it, its description built from the AI grade, and
// its structured data, a ProfilePage about the person. Nothing here is shown
// on the page itself; both profile pages (app/p/[slug]/page.tsx and, with
// TOOLS_ENABLED, ./profile-v2.tsx) use it. Pure: lib/profile.ts loadSeoFacts
// reads the data.

/** Search results cut descriptions at about this many characters. */
export const DESCRIPTION_MAX = 160;

/** The person's profiles their site links to (app/api/inspect, cached a week), when known. */
export type Socials = { github: string | null; linkedin: string | null; x: string | null };

export type SeoFacts = {
  name: string;
  url: string;
  domain: string;
  tagline: string | null;
  /** The AI grade's public part, or null when there is none or the owner hid it. */
  report: Pick<ReportCard, "roles" | "axes" | "isPortfolio"> | null;
  /** The health check hides the site (down, dead, parked; lib/hidden.mjs). */
  hidden: boolean;
  socials: Socials;
};

/** Graded, a real portfolio and not hidden: the only profiles search engines are asked to index. */
export const indexable = (f: Pick<SeoFacts, "report" | "hidden">) => Boolean(f.report?.isPortfolio) && !f.hidden;

/** The AI review's best criteria (4 or 5 out of 5), best first, at most two. */
function strengths(f: SeoFacts): string | null {
  const best = [...(f.report?.axes ?? [])].filter((a) => a.score >= 4).sort((a, b) => b.score - a.score).slice(0, 2);
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
 * At most DESCRIPTION_MAX characters from the data: who and what (the
 * grade's roles), the review's strongest criteria, then the person's own
 * tagline, each added while it fits.
 */
export function profileDescription(f: SeoFacts): string {
  const roles = f.report?.roles ?? [];
  const kind = roles.length ? `${roles.slice(0, 2).join(" and ")} portfolio` : "developer portfolio";
  const parts = [`${f.name}'s ${kind} at ${f.domain}.`, strengths(f), f.tagline ? `“${f.tagline.trim().replace(/[.\s]+$/, "")}.”` : null];
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
export function profilePageLd(f: SeoFacts, { canonical, title, siteUrl, siteName }: { canonical: string; title: string; siteUrl: string; siteName: string }) {
  const sameAs = [f.url, f.socials.github, f.socials.linkedin, f.socials.x].filter((u): u is string => Boolean(u));
  const role = f.report?.roles[0];
  return {
    "@type": "ProfilePage",
    "@id": canonical,
    url: canonical,
    name: title,
    description: profileDescription(f),
    inLanguage: "en",
    isPartOf: { "@type": "WebSite", name: siteName, url: siteUrl },
    mainEntity: {
      "@type": "Person",
      "@id": `${canonical}#person`,
      name: f.name,
      url: f.url,
      sameAs: [...new Set(sameAs)],
      ...(role ? { jobTitle: titleCase(role) } : {}),
      ...(f.tagline ? { description: f.tagline } : {}),
    },
  };
}

/** An https link on one of these hosts, or null: scraped links are never trusted as they are. */
function socialLink(raw: unknown, hosts: RegExp): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && hosts.test(u.hostname) && u.pathname.length > 1 ? u.href : null;
  } catch {
    return null;
  }
}

/** The social links from a cached page check (app/api/inspect's githubUrl, linkedinUrl, xUrl). */
export function socialsFrom(inspected: { githubUrl?: unknown; linkedinUrl?: unknown; xUrl?: unknown } | null | undefined): Socials {
  return {
    github: socialLink(inspected?.githubUrl, /^(www\.)?github\.com$/i),
    linkedin: socialLink(inspected?.linkedinUrl, /^([a-z]{2,3}\.|www\.)?linkedin\.com$/i),
    x: socialLink(inspected?.xUrl, /^(www\.)?(x|twitter)\.com$/i),
  };
}
