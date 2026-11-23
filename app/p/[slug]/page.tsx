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
import { BASE_ELO } from "@/lib/elo";
import { type CodeChecks, loadCodeChecks, loadProfileTier } from "@/lib/tiers-view";
import { ProfileTier } from "@/components/tiers/ProfileTier";
import { CheckItems } from "@/components/tiers/CheckItems";
import { heroOf, mshotsUrl, shotBases } from "@/lib/shots";
import { db, ensureSchema } from "@/lib/db";
import { isGone } from "@/lib/roster";
import { SITE_URL } from "@/lib/site";
import { AI_CRITERIA } from "@/pipeline/rubric.mjs";
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

// The AI-judged criteria and their names come from the rubric itself
// (pipeline/rubric.mjs), so the page follows it when it changes.
const AXIS_LABELS: Record<string, string> = Object.fromEntries(
  AI_CRITERIA.map((c) => [c.id, c.name])
);

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

// The Gemini report card shows for any graded site under a neutral "AI" mark:
// Gemini's own letter is never shown (owner, 2026-11-22: the grading is kept
// apart from the ranking; the Tier comes from the code checks and votes).
function publicGrade(raw: unknown): null | {
  model?: string;
  /** Rubric v2: Gemini's weighted quality (1-5). */
  quality?: number;
  axes: { key: string; label: string; score: number; note?: string }[];
} {
  type Raw = Record<string, { score?: number; note?: string } | string | undefined>;
  let r: Raw;
  if (raw && typeof raw === "object") r = raw as Raw;
  else if (typeof raw !== "string") return null;
  else {
    try {
      r = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const tier = r.tier as string | undefined;
  if (!tier || !["S", "A", "B", "C", "D"].includes(tier)) return null;
  const axes = Object.entries(AXIS_LABELS)
    .map(([key, label]) => {
      const ax = r[key];
      if (!ax || typeof ax === "string" || typeof ax.score !== "number") return null;
      return { key, label, score: ax.score, note: ax.note };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);
  return {
    model: typeof r.model === "string" ? r.model : undefined,
    quality: typeof r.quality_score === "number" ? r.quality_score : undefined,
    axes,
  };
}

/** The Code checks score item by item, while the tier card (RANKING_V2) is off: the same list it shows. */
function CodeChecksCard({ code }: { code: CodeChecks }) {
  return (
    <section aria-labelledby="code-checks" className="mb-4 rounded-xl border border-edge bg-card p-5">
      <h2 id="code-checks" className="font-semibold">
        Code checks score: <span className="tabular-nums">{Math.round(code.check.total)}</span> of 100
      </h2>
      <p className="mt-0.5 text-xs text-mute">Measured by code from the page, its speed and its share card. No AI is involved.</p>
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
  const grade = owner.hideGrade ? null : publicGrade(rubricRow?.ai_rubric);
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
        </div>

        {eloTier && <ProfileTier t={eloTier} />}
        {!eloTier && code && <CodeChecksCard code={code} />}

        <DetailDiagnostics url={url} initialInspection={inspection} />

        {!grade && !owner.hideGrade && (
          <section aria-labelledby="report-card" className="mt-4 rounded-xl border border-edge bg-card p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-edge text-lg font-bold text-mute" aria-hidden>
                AI
              </span>
              <div>
                <h2 id="report-card" className="font-semibold">
                  {eloTier ? "Report card: how to improve" : "Gemini report card"}
                </h2>
                <p className="text-sm text-mute">
                  The model has not looked at this site yet.{code ? " The code checks above are measured without it." : ""}
                </p>
              </div>
            </div>
          </section>
        )}

        {grade && (
          <div className="mt-4 rounded-xl border border-edge bg-card p-5">
            <div className="flex items-center gap-3">
              {/* Gemini's own letter is never shown: the report card sits under a neutral mark. */}
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-edge text-lg font-bold text-ink">AI</span>
              <div>
                <p className="font-semibold">{eloTier ? "Report card: how to improve" : "Gemini report card"}</p>
                <p className="text-xs text-mute">
                  by Gemini{grade.model ? ` (${grade.model})` : ""} - an opinion, not
                  a verdict
                </p>
                {/* Gemini's own numbers only: the Code checks score is code's and sits in its own card above. */}
                {grade.quality !== undefined && (
                  <p className="mt-0.5 text-xs text-mute">
                    Quality <span className="font-semibold tabular-nums text-ink">{grade.quality.toFixed(1)}/5</span>
                  </p>
                )}
              </div>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {grade.axes.map((ax) => (
                <div key={ax.key} className="rounded-lg border border-edge p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{ax.label}</span>
                    <span className="text-sm font-bold tabular-nums">
                      {ax.score}/5
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full rounded-full bg-edge">
                    <div
                      className="h-1.5 rounded-full bg-accent"
                      style={{ width: `${(ax.score / 5) * 100}%` }}
                    />
                  </div>
                  {ax.note && (
                    <p className="mt-1.5 text-xs text-mute">{ax.note}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

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
