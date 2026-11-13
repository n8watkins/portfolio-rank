import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowUpRight, Clock, Hourglass, Sparkles, Trophy } from "lucide-react";
import { Socials } from "@/components/Diagnostics";
import { LikeButton } from "@/components/LikeButton";
import { ShareButton } from "@/components/ShareButton";
import { AddToListButton } from "@/components/AddToListButton";
import { heroOf, mshotsUrl, shotBases } from "@/lib/shots";
import { SITE_URL } from "@/lib/site";
import { ROUTES } from "@/lib/nav";
import { eyebrow } from "@/components/ui/styles";
import { loadProfile, loadSeoExtras, profileJsonLd, profileUrlForPath, type Profile } from "@/lib/profile";
import { indexable, profileDescription, type SeoFacts } from "@/lib/profile-seo";
import { jsonLdHtml } from "@/lib/json-ld";
import { FixList } from "@/components/profile/FixList";
import { RecheckButton } from "@/components/profile/RecheckButton";

// A portfolio's profile with "Add your portfolio" (TOOLS_ENABLED on; ./page.tsx
// picks it): four parts, Rank, Report card, Fix list and Share, for a listed
// portfolio or one added through /add (lib/profile.ts). Nothing here depends
// on who is looking: the ♥ state and the owner's "Re-check my site" load in
// the browser.

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

/** What search engines read about this profile: its own grade (an added site's too), plus the health check and social links. */
async function seoFactsOf(p: Profile): Promise<SeoFacts> {
  const { hidden, socials } = await loadSeoExtras(p.url);
  return { name: p.name, url: p.url, domain: p.domain, tagline: p.tagline, report: p.report, hidden, socials };
}

export async function profileMetadata({ params }: { params: Promise<{ slug: string[] }> }): Promise<Metadata> {
  const { slug } = await params;
  const url = await profileUrlForPath(slug.join("/"));
  const p = url ? await loadProfile(url) : null;
  if (!p) return {};
  const canonical = `${SITE_URL}${p.path}`;
  const facts = await seoFactsOf(p);
  // Graded, a real portfolio and not hidden by the health check: the only profiles search engines are asked to index.
  if (!indexable(facts)) {
    return { title: `${p.name} - PortfolioRank`, robots: { index: false, follow: true }, alternates: { canonical } };
  }
  const title = seoTitle(p);
  // From the grade (lib/profile-seo.ts).
  const description = profileDescription(facts);
  return {
    title,
    description,
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

// Where it stands: ELO from the face-offs (tier letters come with #189).
function Rank({ p }: { p: Profile }) {
  const s = p.standing;
  return (
    <section aria-labelledby="rank" className="card p-5 sm:p-6">
      <SectionTitle id="rank" kicker="Rank" title="Where it stands" />
      <div className="flex items-center gap-5">
        <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-raised text-lg font-bold tabular-nums ring-1 ring-inset ring-edge">
          {p.listed ? s.elo : <span className="font-semibold text-mute" aria-hidden>?</span>}
        </span>
        <div className="min-w-0 flex-1">
          {!p.listed ? (
            <>
              <p className="font-semibold">Not ranked yet</p>
              <p className="text-sm text-mute">It joins the face-offs once it&apos;s graded.</p>
            </>
          ) : (
            <p className="text-sm text-mute">
              ELO <span className="font-semibold tabular-nums text-ink">{s.elo}</span> from {s.faceoffs} face-off{s.faceoffs === 1 ? "" : "s"}. It moves as people vote.
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
            AI design review by Gemini{r.model ? ` (${r.model})` : ""}: an opinion, not a verdict ·{" "}
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

export async function ProfileV2({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const url = await profileUrlForPath(slug.join("/"));
  const p = url ? await loadProfile(url) : null;
  if (!p) notFound();
  const shot = await shotFor(p);
  // A ProfilePage about the person and its breadcrumb trail, indexable profiles only (lib/profile-seo.ts).
  const jsonLd = profileJsonLd(await seoFactsOf(p), { canonical: `${SITE_URL}${p.path}`, title: seoTitle(p) });

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 pb-12 pt-6 sm:px-6">
      {jsonLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(jsonLd) }} />}
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
                <ShareButton url={`${SITE_URL}${p.path}`} title={p.name} />
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
            Added to PortfolioRank. Until the site is graded, this page isn&apos;t listed on PortfolioRank or indexed by search engines, but it isn&apos;t private: anyone who has or guesses its address can open it.
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

      {ROUTES.add && (
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
