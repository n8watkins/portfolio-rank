import type { Metadata } from "next";
import { notFound } from "next/navigation";
import feed from "@/data/feed.json";
import type { Portfolio } from "@/app/page";
import { DetailDiagnostics, Socials } from "@/components/Diagnostics";
import { LikeButton } from "@/components/LikeButton";
import { ShareButton } from "@/components/ShareButton";
import { AddToListButton } from "@/components/AddToListButton";
import { heroOf, mshotsUrl, shotBases } from "@/lib/shots";
import { db, ensureSchema } from "@/lib/db";
import { SITE_URL } from "@/lib/site";
import { AI_CRITERIA } from "@/pipeline/rubric.mjs";
import { ownerState } from "@/lib/games/claims.mjs";
import { BELOW_TOP_TIERS, MIN_FACEOFFS, STARTING_TIER, familyOf, isPublicTier, tierLabel, tierOf } from "@/lib/tiers.mjs";
import { readSiteRow, readTierMeta, standingOf } from "@/lib/tiers-db.mjs";
import { pointFixes, unpackCheck } from "@/lib/check-points.mjs";
import { TierBadge } from "@/components/ui/badges";
import { ROUTES } from "@/lib/nav";

// Rendered on first visit and then served from the cache, re-rendered at most
// every 5 minutes (ISR); nothing here depends on who is looking - the ♥ state
// is the visitor's own and loads in the browser (LikeButton hydrate).
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

// The tier comes from the ELO (face-offs, lib/tiers.mjs) and shows only for
// the top tiers (SSS to B-): a lower one says "Graded, below the top tiers",
// so we never slap a public "D" on someone's work. The AI review is the report
// card: its scores and notes, weakest first, as how to improve.
type Standing = {
  tier: string | null;
  elo: number;
  faceoffs: number;
  /** Real face-offs (people's votes and AI comparisons), each counted once. */
  votes: number;
  top: number | null;
  of: number | null;
  provisional: boolean;
  /** Its starting rank came from automated checks (lib/check-points.mjs); `check` is the points breakdown. */
  seeded: boolean;
  check: ReturnType<typeof unpackCheck>;
};

/** The stored rank of a grade (lib/tiers-store.mjs), or null. */
function rankOf(raw: unknown): Standing | null {
  if (typeof raw !== "string") return null;
  try {
    const g = JSON.parse(raw);
    const tier = tierOf(g);
    const r = g?.rank;
    if (!tier || typeof r?.elo !== "number") return null;
    return {
      tier,
      elo: r.elo,
      faceoffs: Number(r.faceoffs ?? 0),
      votes: Number(r.votes ?? 0),
      top: typeof r.top === "number" ? r.top : null,
      of: typeof r.of === "number" ? r.of : null,
      provisional: r.provisional !== false,
      seeded: r.seeded === true,
      check: unpackCheck(r.check),
    };
  } catch {
    return null;
  }
}

function publicGrade(raw: unknown): null | {
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
  // A real grade: Gemini answered (its own letter is there, never shown).
  if (typeof r.tier !== "string" || !r.tier || "error" in r) return null;
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
    checks: typeof r.checks_score === "number" ? r.checks_score : undefined,
    axes,
  };
}

export default async function PortfolioPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const url = decodeURIComponent(slug);
  const portfolio = (feed as Portfolio[]).find((p) => p.url === url);
  if (!portfolio) notFound();

  await ensureSchema();

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
  // The ELO and tier from face-offs: stored with the grade by the hourly refresh, else (not graded) from its library row.
  // The letter, ELO and place derived on read from its rating row and the daily cutoffs (lib/tiers-db.mjs):
  // two reads by key, always as current as the last vote. The points breakdown comes with the stored grade.
  const stored = rankOf(rubricRow?.ai_rubric);
  const [row, meta] = await Promise.all([readSiteRow(db(), url), readTierMeta(db())]);
  const live = standingOf(row, meta);
  const standing: Standing = {
    tier: stored ? (live.tier ?? stored.tier) : null,
    elo: live.elo,
    faceoffs: live.faceoffs,
    votes: live.votes,
    top: live.top,
    of: live.of,
    provisional: live.provisional,
    seeded: live.seeded,
    check: stored?.check ?? null,
  };
  // A hidden grade hides the tier too; C and D never show.
  const shownTier = !owner.hideGrade && isPublicTier(standing.tier) ? standing.tier : null;
  const faceoffs = Math.floor(standing.faceoffs);
  const votes = standing.votes;
  const votesText = `${votes.toLocaleString("en-US")} real vote${votes === 1 ? "" : "s"}`;
  const fixes = standing.check ? pointFixes(standing.check) : [];
  const strong = familyOf(shownTier) === "A" || familyOf(shownTier) === "S";

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
                <p className="text-xl font-bold tabular-nums">{standing.elo}</p>
                <p className="text-xs text-mute">ELO · {votesText}</p>
                {stars > 0 && (
                  <p className="text-xs font-semibold text-accent">
                    ⭐ {stars} loved
                  </p>
                )}
              </div>
              <Socials url={url} />
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

        <section aria-labelledby="tier" className={`mb-4 rounded-xl border bg-card p-5 ${strong ? "border-accent/50 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-accent)_25%,transparent),0_12px_32px_-18px_var(--color-accent)]" : "border-edge"}`}>
          <div className="flex items-center gap-4">
            {shownTier ? (
              <a href="/grading#tiers" aria-label={`Tier ${tierLabel(shownTier)}: how tiers work`} className="rounded-2xl">
                <TierBadge tier={shownTier} size="lg" />
              </a>
            ) : (
              <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-raised text-sm font-semibold text-mute ring-1 ring-inset ring-edge" aria-hidden>
                {standing.tier ? "-" : "?"}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <h2 id="tier" className="text-xs font-semibold uppercase tracking-[0.14em] text-mute">
                Tier
              </h2>
              {owner.hideGrade ? (
                <p className="mt-0.5 text-sm text-mute">ELO from {votesText}.</p>
              ) : standing.tier && standing.seeded ? (
                <>
                  <p className={`mt-0.5 font-semibold ${strong ? "text-accent" : ""}`}>
                    {shownTier ? (standing.top != null ? `Top ${standing.top}%` : `Tier ${tierLabel(shownTier)}`) : BELOW_TOP_TIERS}
                    {shownTier && standing.of != null && <span className="font-normal text-mute"> of {standing.of.toLocaleString("en-US")} ranked portfolios</span>}
                  </p>
                  <p className="text-sm text-mute">Starting rank from automated checks · {votesText}. Votes move it from here.</p>
                </>
              ) : standing.tier && standing.provisional ? (
                <>
                  <p className="mt-0.5 font-semibold">Starting tier: {STARTING_TIER}</p>
                  <p className="text-sm text-mute">
                    {faceoffs} of {MIN_FACEOFFS} face-offs. After {MIN_FACEOFFS}, its place by ELO sets the tier.
                  </p>
                </>
              ) : standing.tier && shownTier ? (
                <>
                  <p className={`mt-0.5 font-semibold ${strong ? "text-accent" : ""}`}>
                    {standing.top != null ? `Top ${standing.top}%` : `Tier ${tierLabel(shownTier)}`}
                    {standing.of != null && <span className="font-normal text-mute"> of {standing.of.toLocaleString("en-US")} ranked portfolios</span>}
                  </p>
                  <p className="text-sm text-mute">By ELO from {votesText}. It moves as people vote.</p>
                </>
              ) : standing.tier ? (
                <p className="mt-0.5 text-sm text-mute">{BELOW_TOP_TIERS}. ELO from {votesText}.</p>
              ) : (
                <p className="mt-0.5 text-sm text-mute">Not graded yet, so no tier. ELO from {votesText}.</p>
              )}
            </div>
            {ROUTES.faceoff && (
              <a href={ROUTES.faceoff} className="hidden shrink-0 rounded-lg border border-edge-strong px-3 py-2 text-sm font-semibold transition hover:border-accent sm:block">
                Vote in a face-off
              </a>
            )}
          </div>
          {!owner.hideGrade && standing.check && (
            <div className="mt-4 grid grid-cols-1 gap-4 border-t border-edge pt-4 md:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
              <div>
                <h3 className="text-sm font-semibold">
                  Automated checks: <span className="tabular-nums">{standing.check.total}</span> of 100 points
                </h3>
                <ul className="mt-2 grid grid-cols-1 gap-x-6 text-sm sm:grid-cols-2">
                  {standing.check.items.map((i) => (
                    <li key={i.id} className="flex items-baseline justify-between gap-3 border-b border-edge py-1.5">
                      <span className={i.measured ? "" : "text-mute"}>
                        {i.name}
                        {!i.measured && <span className="block text-[11px]">Not measured yet: library median</span>}
                      </span>
                      <span className={`shrink-0 tabular-nums ${i.id === "template" && i.points < 0 ? "text-down" : i.measured && i.points >= i.max ? "text-up" : "text-mute"}`}>
                        {i.id === "template" ? (i.points < 0 ? i.points : "0") : `${i.points}/${i.max}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-sm font-semibold">Quickest points</h3>
                {fixes.length ? (
                  <ul className="mt-2 grid gap-2 text-sm">
                    {fixes.map((f) => (
                      <li key={f.id} className="flex items-start gap-2">
                        <span className="shrink-0 rounded-md bg-accent-soft px-1.5 text-xs font-bold leading-5 text-accent tabular-nums">+{Math.round(f.gain)}</span>
                        <span>{f.text.slice(f.text.indexOf(" if you ") + 1)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-mute">Every measured check is full. Votes decide the rest.</p>
                )}
                <a href="/grading#points" className="mt-3 inline-block text-xs font-medium text-accent hover:underline">
                  How the points work
                </a>
              </div>
            </div>
          )}
        </section>

        <DetailDiagnostics url={url} />

        {grade && (
          <section aria-labelledby="improve" className="mt-4 rounded-xl border border-edge bg-card p-5">
            <div className="flex items-center gap-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-edge text-sm font-bold text-ink" aria-hidden>
                AI
              </span>
              <div>
                <h2 id="improve" className="font-semibold">
                  Report card: how to improve
                </h2>
                <p className="text-xs text-mute">
                  AI design review by Gemini{grade.model ? ` (${grade.model})` : ""} - an opinion, not a verdict. It doesn&apos;t set the tier ·{" "}
                  <a href="/grading" className="underline decoration-edge-strong underline-offset-2 hover:text-ink">
                    how grading works
                  </a>
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
              {/* Weakest first: the most room to improve. */}
              {[...grade.axes].sort((a, b) => a.score - b.score).map((ax) => (
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
          </section>
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
