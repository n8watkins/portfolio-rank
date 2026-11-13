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
import { heroOf, mshotsUrl, shotBases } from "@/lib/shots";
import { db, ensureSchema } from "@/lib/db";
import { SITE_URL } from "@/lib/site";
import { AI_CRITERIA } from "@/pipeline/rubric.mjs";
import { ownerState } from "@/lib/games/claims.mjs";
import { toolsEnabled } from "@/lib/tools/server";
import { ProfileV2, profileMetadata } from "./profile-v2";

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
  const img = await shotFor(url);
  const title = `${p.name} - PortfolioRank`;
  const description = p.tagline
    ? `${p.tagline} · ${domainOf(url)}`
    : `Developer portfolio · ${domainOf(url)}`;
  const canonical = `${SITE_URL}/p/${encodeURIComponent(url)}`;
  return {
    title,
    description,
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

// The AI review shows for any graded site, but only the top tiers (S/A/B) get the
// prominent letter badge - lower tiers show the axis scores under a neutral "AI"
// mark, so we never slap a public "D" on someone's work.
function publicGrade(raw: unknown): null | {
  tier: string;
  showTier: boolean;
  model?: string;
  /** Rubric v2: weighted AI quality (1-5) and the share of code checks passed (0-100). */
  quality?: number;
  checks?: number;
  axes: { key: string; label: string; score: number; note?: string }[];
} {
  if (typeof raw !== "string") return null;
  let r: Record<string, { score?: number; note?: string } | string | undefined>;
  try {
    r = JSON.parse(raw);
  } catch {
    return null;
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
    tier,
    showTier: ["S", "A", "B"].includes(tier),
    model: typeof r.model === "string" ? r.model : undefined,
    quality: typeof r.quality_score === "number" ? r.quality_score : undefined,
    checks: typeof r.checks_score === "number" ? r.checks_score : undefined,
    axes,
  };
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
      sql: "SELECT ai_rubric FROM portfolios WHERE url = ?",
      args: [url],
    })
  ).rows[0];
  // A verified owner may remove their portfolio or hide its grade
  // (lib/games/claims.mjs); a removed one is gone at once.
  const owner = await ownerState(db(), url);
  if (owner.removedAt) notFound();
  const grade = owner.hideGrade ? null : publicGrade(rubricRow?.ai_rubric);

  const shot = await shotFor(url);

  return (
    <div className="mx-auto max-w-5xl px-4 pt-6 sm:px-6">
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
                <p className="text-xl font-bold tabular-nums">{rating.elo}</p>
                <p className="text-xs text-mute">
                  ELO · {rating.votes} vote{rating.votes === 1 ? "" : "s"}
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

        <DetailDiagnostics url={url} initialInspection={inspection} />

        {grade && (
          <div className="mt-4 rounded-xl border border-edge bg-card p-5">
            <div className="flex items-center gap-3">
              <span
                className={`flex h-10 w-10 items-center justify-center rounded-lg text-lg font-bold ${
                  grade.showTier ? "bg-fill text-on-fill" : "bg-edge text-ink"
                }`}
              >
                {grade.showTier ? grade.tier : "AI"}
              </span>
              <div>
                <p className="font-semibold">AI design review</p>
                <p className="text-xs text-mute">
                  by Gemini{grade.model ? ` (${grade.model})` : ""} - an opinion, not
                  a verdict
                </p>
                {(grade.quality !== undefined || grade.checks !== undefined) && (
                  <p className="mt-0.5 text-xs text-mute">
                    {grade.quality !== undefined && (
                      <>
                        Quality <span className="font-semibold tabular-nums text-ink">{grade.quality.toFixed(1)}/5</span>
                      </>
                    )}
                    {grade.quality !== undefined && grade.checks !== undefined && " · "}
                    {grade.checks !== undefined && (
                      <>
                        Checks passed <span className="font-semibold tabular-nums text-ink">{grade.checks}/100</span>
                      </>
                    )}
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
