import type { Metadata } from "next";
import { notFound } from "next/navigation";
import feed from "@/data/feed.json";
import type { Portfolio } from "@/app/page";
import { DetailDiagnostics, Socials } from "@/components/Diagnostics";
import type { Inspection } from "@/app/api/inspect/route";
import { peekCached } from "@/lib/cache";
import { LikeButton } from "@/components/LikeButton";
import { ShareButton } from "@/components/ShareButton";
import { AddToListButton } from "@/components/AddToListButton";
import { ReportProblem } from "@/components/profile/ReportProblem";
import { BASE_ELO } from "@/lib/elo";
import { type CodeChecks, loadCodeChecks, loadProfileTier } from "@/lib/tiers-view";
import { ProfileTier } from "@/components/tiers/ProfileTier";
import { CheckItems } from "@/components/tiers/CheckItems";
import { shownPoints } from "@/lib/check-points.mjs";
import { heroOf, mshotsUrl, shotBases } from "@/lib/shots";
import { db, ensureSchema } from "@/lib/db";
import { isGone } from "@/lib/roster";
import { SITE_URL } from "@/lib/site";
import { ownerState } from "@/lib/games/claims.mjs";
import { toolsEnabled } from "@/lib/tools/server";
import { ProfileV2, profileMetadata } from "./profile-v2";
import { loadSeoExtras, profileJsonLd } from "@/lib/profile";
import { indexable, profileDescription, type SeoFacts } from "@/lib/profile-seo";
import { jsonLdHtml } from "@/lib/json-ld";

// Rendered on first visit and then served from the cache, re-rendered at most
// every 5 minutes (ISR); nothing here depends on who is looking - the ♥ state
// is the visitor's own and loads in the browser (LikeButton hydrate).
// With "Add your portfolio" launched (TOOLS_ENABLED) the profile is the
// four-part one with a fix list, for listed and added sites alike
// (./profile-v2.tsx); until then it is this page, unchanged.
export const revalidate = 300;

export async function generateStaticParams() {
  return [];
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

async function shotFor(url: string): Promise<string> {
  const base = (await shotBases([url])).get(url);
  return base ? heroOf(base) : mshotsUrl(url, 1200);
}

/** What search engines read about a listed site (lib/profile-seo.ts), read once per request. */
async function seoFacts(p: Portfolio): Promise<SeoFacts> {
  return { name: p.name, url: p.url, domain: domainOf(p.url), tagline: p.tagline ?? null, ...(await loadSeoExtras(p.url)) };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  if (toolsEnabled()) return profileMetadata({ params });
  const { slug } = await params;
  const url = decodeURIComponent(slug);
  const p = (feed as Portfolio[]).find((x) => x.url === url);
  if (!p) return {};
  const [img, facts] = await Promise.all([shotFor(url), seoFacts(p)]);
  const title = `${p.name} - PortfolioRank`;
  // Indexed: a description from the grade (lib/profile-seo.ts). Ungraded,
  // "not a portfolio", a hidden grade or a site the health check hides: noindex.
  const index = indexable(facts);
  const description = index
    ? profileDescription(facts)
    : p.tagline
      ? `${p.tagline} · ${domainOf(url)}`
      : `Developer portfolio · ${domainOf(url)}`;
  const canonical = `${SITE_URL}/p/${encodeURIComponent(url)}`;
  return {
    title,
    description,
    ...(index ? {} : { robots: { index: false, follow: true } }),
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      type: "website",
      images: [{ url: img }],
    },
    twitter: { card: "summary_large_image", title, description, images: [img] },
  };
}

/** The Code checks score item by item, while the tier card (RANKING_V2) is off: the same list it shows. */
function CodeChecksCard({ code }: { code: CodeChecks }) {
  return (
    <section aria-labelledby="code-checks" className="mb-4 rounded-xl border border-edge bg-card p-5">
      <h2 id="code-checks" className="font-semibold">
        Code checks score: <span className="tabular-nums">{shownPoints(code.check).total}</span> of 100
      </h2>
      <p className="mt-0.5 text-xs text-mute">Measured by code from the page, its speed and its share card. No AI is involved. The starting rank comes from this score; votes move it from there.</p>
      <CheckItems check={code.check} />
    </section>
  );
}

export default async function PortfolioPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  if (toolsEnabled()) return ProfileV2({ params });
  const { slug } = await params;
  const url = decodeURIComponent(slug);
  const portfolio = (feed as Portfolio[]).find((p) => p.url === url);
  if (!portfolio) notFound();
  // A site that is not working has no profile until it works again (lib/hidden.mjs GONE_WHERE).
  if (await isGone(url)) notFound();

  await ensureSchema();
  let rating = { elo: BASE_ELO, votes: 0 };
  const row = (
    await db().execute({
      sql: "SELECT elo, votes FROM ratings WHERE url = ?",
      args: [url],
    })
  ).rows[0];
  if (row) rating = { elo: Number(row.elo), votes: Number(row.votes) };
  // The page check as last measured (/api/inspect's cache), so the social
  // links and the checklist are there at first paint instead of moving the
  // page when the browser's own request answers.
  const inspection = await peekCached<Inspection>("inspect", url).catch(() => null);

  const stars = Number(
    (
      await db().execute({
        // Kept by triggers on votes (lib/schema.mjs COUNTERS), not counted over the vote log.
        sql: "SELECT n FROM star_counts WHERE url = ?",
        args: [url],
      })
    ).rows[0]?.n ?? 0
  );

  // Likes are a separate signal from the ⭐ super-vote: a public save count
  // plus whether the signed-in rater has liked this one (drives the ♥ state).
  const saveCount = Number(
    (
      await db().execute({
        sql: "SELECT COUNT(*) AS n FROM likes WHERE url = ?",
        args: [url],
      })
    ).rows[0]?.n ?? 0
  );

  const rubricRow = (
    await db().execute({
      sql: "SELECT ai_rubric, facts FROM portfolios WHERE url = ?",
      args: [url],
    })
  ).rows[0];
  // A verified owner may remove their portfolio or hide its grade
  // (lib/games/claims.mjs); a removed one is gone at once.
  // Fresh, never the minute cache: this render is kept at the edge for a day.
  const owner = await ownerState(db(), url, { fresh: true });
  if (owner.removedAt) notFound();
  // Tiers by ELO, only while RANKING_V2 is on (lib/tiers-view.ts); null otherwise.
  const eloTier = await loadProfileTier(url, rubricRow?.ai_rubric, owner.hideGrade);
  // The Code checks score, one number for the site wherever it is shown: the tier card's, else made here.
  const code: CodeChecks | null = eloTier
    ? eloTier.check
      ? { check: eloTier.check, fixes: eloTier.fixes }
      : null
    : await loadCodeChecks(url, rubricRow?.ai_rubric, owner.hideGrade);

  const [shot, facts] = await Promise.all([shotFor(url), seoFacts(portfolio)]);
  // A ProfilePage about the person and its breadcrumb trail, indexable profiles only.
  const jsonLd = profileJsonLd(facts, { canonical: `${SITE_URL}/p/${encodeURIComponent(url)}`, title: `${portfolio.name} - PortfolioRank` });

  return (
    <div className="mx-auto max-w-5xl px-4 pt-6 sm:px-6">
      {jsonLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(jsonLd) }} />}
      <div>
        <div className="mb-4 rounded-xl border border-edge bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold tracking-tight">
                {portfolio.name}
              </h1>
              <p className="mt-1 text-sm text-mute">
                {portfolio.tagline ?? "Developer"} · {domainOf(url)}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="mr-1 text-right">
                <p className="text-xl font-bold tabular-nums">{eloTier ? eloTier.elo : rating.elo}</p>
                <p className="text-xs text-mute">
                  {eloTier ? (
                    <>ELO · {eloTier.votes.toLocaleString("en-US")} real vote{eloTier.votes === 1 ? "" : "s"}</>
                  ) : (
                    <>
                      ELO · {rating.votes} vote{rating.votes === 1 ? "" : "s"}
                    </>
                  )}
                </p>
                {stars > 0 && (
                  <p className="text-xs font-semibold text-accent">
                    ⭐ {stars} loved
                  </p>
                )}
              </div>
              <Socials url={url} initial={inspection} />
              {/* count+showCount → the ♥ label carries a live "saved" total that
                  updates when this same button toggles (no stale server value). */}
              <LikeButton
                url={url}
                name={portfolio.name}
                hydrate
                count={saveCount}
                showCount
              />
              <AddToListButton url={url} />
              <ShareButton url={`${SITE_URL}/p/${encodeURIComponent(url)}`} title={portfolio.name} />
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg bg-fill px-4 py-2 text-sm font-semibold text-on-fill transition hover:opacity-85"
              >
                Visit site ↗
              </a>
            </div>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={shot}
            alt={`Screenshot of ${domainOf(url)}`}
            fetchPriority="high"
            className="mt-4 h-56 w-full rounded-lg border border-edge bg-edge object-cover object-top sm:h-72"
          />
          <ReportProblem url={url} domain={domainOf(url)} className="-mb-3 mt-0.5" />
        </div>

        {eloTier && <ProfileTier t={eloTier} />}
        {!eloTier && code && <CodeChecksCard code={code} />}

        <DetailDiagnostics url={url} initialInspection={inspection} />

        {/* No Gemini report card (owner, 2026-11-23): rank and tier come from code measurements and votes, and
            the model's answers are stored, not shown. */}

        <p className="py-8 text-center text-xs text-mute">
          Diagnostics run live against the site and are cached. Think something
          is wrong?{" "}
          <a
            href="https://github.com/n8watkins/portfolio-rank/issues"
            className="underline underline-offset-4 hover:text-ink"
          >
            Open an issue
          </a>
          .
        </p>
      </div>
    </div>
  );
}
