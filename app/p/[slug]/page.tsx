import type { Metadata } from "next";
import { notFound } from "next/navigation";
import feed from "@/data/feed.json";
import type { Portfolio } from "@/app/page";
import { DetailDiagnostics, Socials } from "@/components/Diagnostics";
import { LikeButton } from "@/components/LikeButton";
import { ShareButton } from "@/components/ShareButton";
import { AddToListButton } from "@/components/AddToListButton";
import { BASE_ELO } from "@/lib/elo";
import { heroOf, mshotsUrl, shotBases } from "@/lib/shots";
import { db, ensureSchema } from "@/lib/db";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

const SITE_URL = "https://portfoliorank.vercel.app";

const AXIS_LABELS: Record<string, string> = {
  visual_design: "Visual design",
  five_second_test: "5-second test",
  storytelling: "Storytelling",
  writing: "Writing",
  memorability: "Memorability",
  motion: "Motion",
};

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
  const title = `${p.name} — PortfolioRank`;
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
// prominent letter badge — lower tiers show the axis scores under a neutral "AI"
// mark, so we never slap a public "D" on someone's work.
function publicGrade(raw: unknown): null | {
  tier: string;
  showTier: boolean;
  model?: string;
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
  let rating = { elo: BASE_ELO, votes: 0 };
  const row = (
    await db().execute({
      sql: "SELECT elo, votes FROM ratings WHERE url = ?",
      args: [url],
    })
  ).rows[0];
  if (row) rating = { elo: Number(row.elo), votes: Number(row.votes) };

  const stars = Number(
    (
      await db().execute({
        sql: "SELECT COUNT(*) AS n FROM votes WHERE winner = ? AND starred = 1",
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
  // Read-only identity: only signed-in raters can like, and resolving via
  // auth() (vs getRater) avoids mutating the anon cookie during render.
  const session = await auth();
  const liked =
    !!session?.raterId &&
    (
      await db().execute({
        sql: "SELECT 1 FROM likes WHERE rater_id = ? AND url = ?",
        args: [session.raterId, url],
      })
    ).rows.length > 0;

  const rubricRow = (
    await db().execute({
      sql: "SELECT ai_rubric FROM portfolios WHERE url = ?",
      args: [url],
    })
  ).rows[0];
  const grade = publicGrade(rubricRow?.ai_rubric);

  const shot = await shotFor(url);

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6">
      <header className="flex items-center justify-between py-4">
        <a href="/" className="text-sm font-bold tracking-tight">
          ← Portfolio<span className="text-accent">Rank</span>
        </a>
        <a
          href="/top"
          className="text-xs font-semibold text-mute transition hover:text-ink"
        >
          🏆 Leaderboard
        </a>
      </header>

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
              {saveCount > 0 && (
                <p className="text-xs font-semibold text-rose-400">
                  ♥ {saveCount} saved
                </p>
              )}
            </div>
            <Socials url={url} />
            <LikeButton url={url} initialLiked={liked} />
            <AddToListButton url={url} />
            <ShareButton url={`${SITE_URL}/p/${encodeURIComponent(url)}`} title={portfolio.name} />
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg transition hover:opacity-85"
            >
              Visit site ↗
            </a>
          </div>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={shot}
          alt={`Screenshot of ${domainOf(url)}`}
          className="mt-4 h-56 w-full rounded-lg border border-edge bg-edge object-cover object-top sm:h-72"
        />
      </div>

      <DetailDiagnostics url={url} />

      {grade && (
        <div className="mt-4 rounded-xl border border-edge bg-card p-5">
          <div className="flex items-center gap-3">
            <span
              className={`flex h-10 w-10 items-center justify-center rounded-lg text-lg font-bold ${
                grade.showTier ? "bg-accent text-bg" : "bg-edge text-mute"
              }`}
            >
              {grade.showTier ? grade.tier : "AI"}
            </span>
            <div>
              <p className="font-semibold">AI design review</p>
              <p className="text-xs text-mute">
                by Gemini{grade.model ? ` (${grade.model})` : ""} — an opinion, not
                a verdict
              </p>
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
  );
}
