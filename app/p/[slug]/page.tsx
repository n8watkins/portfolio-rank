import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowUpRight, Clock, Hourglass, Sparkles, Trophy } from "lucide-react";
import { Socials } from "@/components/Diagnostics";
import { LikeButton } from "@/components/LikeButton";
import { ShareButton } from "@/components/ShareButton";
import { AddToListButton } from "@/components/AddToListButton";
import { heroOf, mshotsUrl, shotBases } from "@/lib/shots";
import { SITE_URL } from "@/lib/site";
import { BELOW_TOP_TIERS, MIN_FACEOFFS, STARTING_TIER, familyOf, tierLabel } from "@/lib/tiers.mjs";
import { TierBadge } from "@/components/ui/badges";
import { ROUTES } from "@/lib/nav";
import { eyebrow } from "@/components/ui/styles";
import { loadProfile, type Profile } from "@/lib/profile";
import { FixList } from "@/components/profile/FixList";
import { RecheckButton } from "@/components/profile/RecheckButton";

// A portfolio's profile, the product (owner, 2026-11-12): four parts, Rank,
// Report card, Fix list and Share, for a listed portfolio or one added
// through "Add your portfolio" (lib/profile.ts). Rendered on first visit and
// re-rendered at most every 5 minutes (ISR); a re-check revalidates it at
// once. Nothing here depends on who is looking: the ♥ state and the owner's
// "Re-check my site" load in the browser.
export const revalidate = 300;

export async function generateStaticParams() {
  return [];
}

async function shotFor(p: Profile): Promise<string> {
  if (p.listed) {
    const base = (await shotBases([p.url])).get(p.url);
    if (base) return heroOf(base);
  }
  const og = p.saved.share?.ok && p.saved.share.card?.image?.loads ? p.saved.share.card.image.url : null;
  return og ?? mshotsUrl(p.url, 1200);
}

/** "Jane Doe, Frontend Developer Portfolio | PortfolioRank" from the grade's roles, for search. */
function seoTitle(p: Profile) {
  const role = p.report?.roles[0];
  const cap = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
  return `${p.name}${role ? `, ${cap(role)}` : ""} Portfolio | PortfolioRank`;
}

/** Graded and a real portfolio: the only profiles search engines are asked to index. */
const indexable = (p: Profile) => Boolean(p.report?.isPortfolio);

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const p = await loadProfile(decodeURIComponent(slug));
  if (!p) return {};
  const canonical = `${SITE_URL}${p.path}`;
  if (!indexable(p)) {
    return { title: `${p.name} - PortfolioRank`, robots: { index: false, follow: true }, alternates: { canonical } };
  }
  const title = seoTitle(p);
  const roles = p.report?.roles ?? [];
  const description = (p.tagline ? `${p.tagline} ` : "") + `${roles.length ? `${roles.join(", ")} portfolio` : "Developer portfolio"} at ${p.domain}${p.tier ? `, tier ${tierLabel(p.tier)} on PortfolioRank` : " on PortfolioRank"}.`;
  return {
    title,
    description: description.slice(0, 300),
    alternates: { canonical },
    openGraph: { title, description, url: canonical, type: "profile" },
    twitter: { card: "summary_large_image", title, description },
  };
}

function SectionTitle({ id, kicker, title, children }: { id: string; kicker: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className={eyebrow}>{kicker}</p>
        <h2 id={id} className="mt-1 text-xl font-bold tracking-tight">
          {title}
        </h2>
      </div>
      {children}
    </div>
  );
}

function Rank({ p }: { p: Profile }) {
  const s = p.standing;
  const faceoffs = Math.floor(s.faceoffs);
  const strong = familyOf(p.tier) === "A" || familyOf(p.tier) === "S";
  const toGo = Math.max(0, MIN_FACEOFFS - faceoffs);
  return (
    <section aria-labelledby="rank" className={`card p-5 sm:p-6 ${strong ? "card-featured" : ""}`}>
      <SectionTitle id="rank" kicker="Rank" title={p.tier && !s.provisional ? (s.top != null ? `Top ${s.top}%` : `Tier ${tierLabel(p.tier)}`) : "Where it stands"} />
      <div className="flex items-center gap-5">
        {p.tier ? (
          <a href="/grading#tiers" aria-label={`Tier ${tierLabel(p.tier)}: how tiers work`} className="rounded-2xl">
            <TierBadge tier={p.tier} size="lg" />
          </a>
        ) : (
          <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-raised text-lg font-semibold text-mute ring-1 ring-inset ring-edge" aria-hidden>
            ?
          </span>
        )}
        <div className="min-w-0 flex-1">
          {!p.listed ? (
            <>
              <p className="font-semibold">Not ranked yet</p>
              <p className="text-sm text-mute">It joins the face-offs once it&apos;s graded, starting at tier {STARTING_TIER}.</p>
            </>
          ) : p.hideGrade ? (
            <p className="text-sm text-mute">ELO {s.elo} from {faceoffs} face-offs. The owner hid the grade.</p>
          ) : s.tier && s.provisional ? (
            <>
              <p className="font-semibold">
                {toGo} of {MIN_FACEOFFS} face-offs until its letter
              </p>
              <p className="text-sm text-mute">Every portfolio starts at {STARTING_TIER}; after {MIN_FACEOFFS} face-offs its ELO sets the tier.</p>
              <div className="mt-2 h-1.5 w-full max-w-xs rounded-full bg-edge" role="progressbar" aria-label="Face-offs toward a letter" aria-valuemin={0} aria-valuemax={MIN_FACEOFFS} aria-valuenow={Math.min(faceoffs, MIN_FACEOFFS)}>
                <div className="h-1.5 rounded-full bg-accent" style={{ width: `${(Math.min(s.faceoffs, MIN_FACEOFFS) / MIN_FACEOFFS) * 100}%` }} />
              </div>
            </>
          ) : s.tier && p.tier ? (
            <p className="text-sm text-mute">
              ELO <span className="font-semibold tabular-nums text-ink">{s.elo}</span> from {faceoffs} face-offs
              {s.of != null ? ` among ${s.of.toLocaleString("en-US")} ranked portfolios` : ""}. It moves as people vote.
            </p>
          ) : s.tier ? (
            <p className="text-sm text-mute">
              {BELOW_TOP_TIERS}. ELO {s.elo} from {faceoffs} face-offs.
            </p>
          ) : (
            <p className="text-sm text-mute">
              Not graded yet, so no letter. ELO {s.elo} from {faceoffs} face-offs.
            </p>
          )}
        </div>
        {p.listed && ROUTES.faceoff && (
          <a href={ROUTES.faceoff} className="hidden shrink-0 rounded-lg border border-edge-strong px-3 py-2 text-sm font-semibold transition hover:border-accent sm:block">
            Vote in a face-off
          </a>
        )}
      </div>
    </section>
  );
}

function ReportCard({ p }: { p: Profile }) {
  const r = p.report;
  return (
    <section aria-labelledby="report" className="card p-5 sm:p-6">
      <SectionTitle id="report" kicker="Report card" title={r ? "How to improve, weakest first" : "Coming"} />
      {r ? (
        <>
          <p className="-mt-2 mb-4 text-xs text-mute">
            AI design review by Gemini{r.model ? ` (${r.model})` : ""}: an opinion, not a verdict, and it doesn&apos;t set the tier ·{" "}
            <a href="/grading" className="underline decoration-edge-strong underline-offset-2 hover:text-ink">
              how grading works
            </a>
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[...r.axes]
              .sort((a, b) => a.score - b.score)
              .map((ax) => (
                <div key={ax.key} className="rounded-lg border border-edge p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{ax.label}</span>
                    <span className="text-sm font-bold tabular-nums">{ax.score}/5</span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full rounded-full bg-edge">
                    <div className="h-1.5 rounded-full bg-accent" style={{ width: `${(ax.score / 5) * 100}%` }} />
                  </div>
                  {ax.note && <p className="mt-1.5 text-xs text-mute">{ax.note}</p>}
                </div>
              ))}
          </div>
        </>
      ) : (
        <p className="flex items-start gap-3 text-sm text-mute">
          {p.stage === "grading" ? <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden /> : <Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />}
          <span>
            {p.stage === "grading"
              ? "Being graded now: Gemini reads a screenshot and the page and scores design, writing and projects. This page fills in when it's done."
              : p.hideGrade
                ? "The owner hid the grade."
                : "Waiting for its AI grade. We grade new portfolios when there's room in the day's free quota; this page fills in when it's done."}
            {p.job?.reason ? ` ${p.job.reason}` : ""}
          </span>
        </p>
      )}
    </section>
  );
}

function ShareCard({ p }: { p: Profile }) {
  if (!p.tier) return null;
  const link = `${SITE_URL}${p.path}`;
  return (
    <section aria-labelledby="share" className="card p-5 sm:p-6">
      <SectionTitle id="share" kicker="Share" title={`Tier ${tierLabel(p.tier)}: show it off`}>
        <ShareButton url={link} title={p.name} />
      </SectionTitle>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`${p.path}/opengraph-image`} alt={`${p.name}'s PortfolioRank card, tier ${tierLabel(p.tier)}`} loading="lazy" className="w-full max-w-xl rounded-xl border border-edge" />
    </section>
  );
}

export default async function PortfolioPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const p = await loadProfile(decodeURIComponent(slug));
  if (!p) notFound();
  const shot = await shotFor(p);
  const jsonLd = indexable(p)
    ? {
        "@context": "https://schema.org",
        "@type": "ProfilePage",
        url: `${SITE_URL}${p.path}`,
        name: seoTitle(p),
        mainEntity: {
          "@type": "Person",
          name: p.name,
          ...(p.report?.roles.length ? { jobTitle: p.report.roles[0] } : {}),
          url: p.url,
          sameAs: [p.url],
        },
      }
    : null;

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 pb-12 pt-6 sm:px-6">
      {jsonLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />}
      <header className="card overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-4 p-5 sm:p-6">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{p.name}</h1>
            <p className="mt-1 text-sm text-mute">
              {p.tagline ? `${p.tagline} · ` : ""}
              {p.domain}
            </p>
            {p.report?.roles.length ? <p className="mt-2 text-xs font-medium uppercase tracking-wider text-mute">{p.report.roles.join(" · ")}</p> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {p.listed && (
              <>
                <Socials url={p.url} />
                <LikeButton url={p.url} name={p.name} hydrate count={p.saves} showCount />
                <AddToListButton url={p.url} />
              </>
            )}
            <a href={p.url} target="_blank" rel="noopener" className="group btn-sheen inline-flex h-11 items-center gap-2 rounded-lg bg-fill px-5 text-sm font-semibold text-on-fill transition active:scale-[0.97]">
              Visit {p.domain} <ArrowUpRight className="h-4 w-4" aria-hidden />
            </a>
          </div>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={shot} alt={`Screenshot of ${p.domain}`} fetchPriority="high" className="h-56 w-full border-t border-edge bg-raised object-cover object-top sm:h-80" />
      </header>

      {!p.listed && (
        <p className="flex items-start gap-2 rounded-xl border border-edge bg-card p-3.5 text-sm">
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-mute" aria-hidden />
          <span>
            Added to PortfolioRank. This page is private until the site is graded: only people with the link can see it, and search engines don&apos;t list it.
          </span>
        </p>
      )}

      <Rank p={p} />
      <ReportCard p={p} />

      <section aria-labelledby="fixes" className="card p-5 sm:p-6">
        <SectionTitle id="fixes" kicker="Fix list" title="What to fix, and how">
          {p.listed && <RecheckButton url={p.url} />}
        </SectionTitle>
        <FixList p={p} />
      </section>

      <ShareCard p={p} />

      {!p.tier && ROUTES.add && (
        <p className="flex items-center justify-center gap-2 pt-4 text-sm text-mute">
          <Trophy className="h-4 w-4 text-accent" aria-hidden /> Know a great portfolio?{" "}
          <a href={ROUTES.add} className="font-semibold text-accent underline-offset-4 hover:underline">
            Add your portfolio
          </a>
        </p>
      )}
    </div>
  );
}
