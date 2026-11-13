import { ArrowRight, Check, ExternalLink, Minus, X } from "lucide-react";
import { Celebration } from "@/components/grade/Celebration";
import { OwnerPanel } from "@/components/grade/OwnerPanel";
import { ReportToolbar } from "@/components/grade/ReportToolbar";
import { PublicTierBadge, TierBadge } from "@/components/ui/badges";
import { ScreenshotFrame } from "@/components/ui/ScreenshotFrame";
import type { GradePage } from "@/lib/grade-page";
import { ROUTES } from "@/lib/nav";
import { SITE, SITE_URL } from "@/lib/site";
import { REGRADE_COOLDOWN_DAYS } from "@/pipeline/budget.mjs";
import { MIN_FACEOFFS } from "@/lib/tiers.mjs";

// The grade report (owner direction, 2026-11-12: "a report, not a sales
// page"): a small header (name, address, tier, Top N%, a thumbnail), then
// the fixes in priority order, then the findings, dense and scannable. The
// same layout prints: the print styles (app/globals.css, .grade-report) drop
// the buttons and the site's chrome and set it on paper, so a typical report
// fits two pages of Letter or A4, with the address and page numbers in each
// page's footer.

type Celebrate = Parameters<typeof Celebration>[0]["level"];

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });
const shortUrl = (url: string) => url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");

/** A small heading for a report section. */
function H2({ id, children, note }: { id: string; children: React.ReactNode; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-edge pb-1.5">
      <h2 id={id} className="text-[15px] font-bold tracking-tight">
        {children}
      </h2>
      {note && <p className="text-xs text-mute">{note}</p>}
    </div>
  );
}

export function Report({ page, link, celebration, now }: { page: GradePage; link: React.ReactNode; celebration: Celebrate; now: number }) {
  const { job } = page;
  const rep = job.report!;
  const view = page.report!;
  const pct = rep.percentile;
  const judgments = rep.judgments.filter((j) => typeof j.score === "number");
  const facts = rep.facts ?? [];
  const joinHref = `${SITE.submit}&url=${encodeURIComponent(job.url)}`;
  const claimHref = page.games && page.listed ? `/claim?url=${encodeURIComponent(page.listed.url)}` : null;
  const reportUrl = `${(process.env.AUTH_URL || SITE_URL).replace(/^https?:\/\//, "").replace(/\/$/, "")}/grade/${job.id}`;
  // The job id is [A-Za-z0-9_-] only (lib/grader/jobs.mjs JOB_ID): safe in a CSS string.
  const pageCss = `@page{margin:12mm 13mm 14mm;@bottom-left{content:"${reportUrl}";font:500 7.5pt Inter,system-ui,sans-serif;color:#6b6b75}@bottom-right{content:"Page " counter(page) " of " counter(pages);font:500 7.5pt Inter,system-ui,sans-serif;color:#6b6b75}}`;

  return (
    <article className="grade-report mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8 print:max-w-none print:p-0" aria-labelledby="overall">
      <style>{pageCss}</style>
      {link}
      <Celebration id={job.id} level={celebration} anchor="report-tier" games={page.games} />

      {/* Header: who, the result, a thumbnail */}
      <header className="flex gap-4 sm:gap-5">
        <a href={job.url} target="_blank" rel="noopener noreferrer" className="hidden w-36 shrink-0 sm:block print:block print:w-[36mm]" tabIndex={-1} aria-hidden>
          <ScreenshotFrame src={page.hero} alt="" domain={job.domain} eager className="w-full overflow-hidden rounded-lg border border-edge" />
        </a>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mute">Grade report · {day(rep.gradedAt)}</p>
          <h1 id="overall" className="mt-0.5 break-words text-2xl font-bold leading-tight tracking-tight">
            {page.name}
          </h1>
          <a href={job.url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 text-sm text-mute hover:text-accent">
            <span className="truncate">{shortUrl(job.url)}</span> <ExternalLink className="h-3 w-3 shrink-0 print:hidden" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
          <p className="mt-2 text-[15px] font-medium text-pretty">{view.verdict}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-right">
          <span id="report-tier">
            {rep.tier ? (
              <a href="/grading#tiers" aria-label={`Tier ${rep.tier}: how tiers work`} className="block rounded-2xl focus-visible:outline-offset-4">
                <TierBadge tier={rep.tier} size="lg" />
              </a>
            ) : (
              <span className="grid h-16 w-16 place-items-center rounded-2xl bg-raised text-lg font-bold text-mute ring-1 ring-inset ring-edge" role="img" aria-label="No tier">
                AI
              </span>
            )}
          </span>
          {rep.tier && (rep.seeded || rep.provisional) && (
            <p className="max-w-[7.5rem] text-[11px] leading-snug text-mute sm:max-w-none">
              {rep.seeded ? "Starting rank from automated checks" : `Starting tier, until ${MIN_FACEOFFS} face-offs`}
            </p>
          )}
          {pct ? (
            <>
              <p className="mt-1 text-xl font-bold leading-none tabular-nums">
                <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-mute">Grade</span>
                Top {pct.topPct}%
              </p>
              <p className="max-w-[7.5rem] text-[11px] leading-snug text-mute tabular-nums sm:max-w-none">Graded against {(pct.total - 1).toLocaleString("en-US")} portfolios</p>
              <a href="/grading#tiers" className="text-[11px] font-medium text-accent hover:underline print:hidden">
                How tiers work
              </a>
            </>
          ) : (
            <p className="text-xs text-mute">{rep.isPortfolio === false ? "Not ranked: not a portfolio" : "Rank once more are graded"}</p>
          )}
        </div>
      </header>
      <div className="mt-4">
        <ReportToolbar id={job.id} domain={job.domain} listed={!!page.listed} joinHref={joinHref} emailed={job.email.requested} games={page.games} />
      </div>

      {/* The fixes, in priority order */}
      <section aria-labelledby="improve" className="mt-7 break-inside-avoid-page">
        <H2 id="improve" note={view.fixes.length ? "Most effect first" : undefined}>
          {view.fixes.length ? "Fix these, in order" : "Nothing urgent to fix"}
        </H2>
        {view.fixes.length ? (
          <ol className="mt-1 divide-y divide-edge">
            {view.fixes.map((f, i) => (
              <li key={f.criterion} className="flex gap-3 py-2.5 break-inside-avoid">
                <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${i === 0 ? "bg-fill text-on-fill" : "bg-raised text-ink ring-1 ring-edge-strong"}`}>{i + 1}</span>
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-semibold">
                    {f.title} <span className="ml-1 text-[11px] font-medium text-mute">{f.by === "code" ? "measured" : "Gemini"}</span>
                  </p>
                  <p className="text-mute">{f.why}</p>
                  {f.effect && <p className="text-[13px]">Expected: {f.effect}</p>}
                  {f.criterion === "project_links" && <BrokenLinks links={page.brokenLinks} count={page.brokenCount} />}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-mute">Every check passes and every score is high. To climb further, get it into more face-offs and re-grade after each big change.</p>
        )}
      </section>

      {/* The findings, side by side */}
      <div className="mt-7 grid grid-cols-1 gap-7 md:grid-cols-2 print:grid-cols-2 print:gap-6">
        <section aria-labelledby="hiring" className="break-inside-avoid">
          <H2 id="hiring" note="Checked by code">
            What a hiring manager sees
          </H2>
          <table className="mt-1 w-full text-sm">
            <tbody>
              {facts.map((f) => (
                <tr key={f.id} className="border-b border-edge last:border-b-0">
                  <td className="w-6 py-1.5 align-top">
                    {f.pass === true ? <Check className="h-4 w-4 text-up" aria-label="Yes" /> : f.pass === false ? <X className="h-4 w-4 text-down" aria-label="No" /> : <Minus className="h-4 w-4 text-mute" aria-label="Not measured" />}
                  </td>
                  <td className="py-1.5 pr-2 align-top font-medium">{f.label}</td>
                  <td className="py-1.5 text-right align-top text-mute">{f.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section aria-labelledby="ai" className="break-inside-avoid">
          <H2 id="ai" note="Gemini, 1 to 5">
            How it looks and reads
          </H2>
          <ul className="mt-1">
            {judgments.map((s) => (
              <li key={s.id} className="border-b border-edge py-1.5 last:border-b-0">
                <div className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 font-medium">{s.label}</span>
                  <span className="flex gap-0.5" aria-hidden>
                    {[1, 2, 3, 4, 5].map((i) => (
                      <span key={i} className={`h-1.5 w-3.5 rounded-full ${i <= (s.score ?? 0) ? ((s.score ?? 0) >= 4 ? "bg-up" : "bg-fill") : "bg-edge"}`} />
                    ))}
                  </span>
                  <span className="w-7 text-right font-semibold tabular-nums">{s.score}/5</span>
                </div>
                {s.note && <p className="text-[13px] leading-snug text-mute">{s.note}</p>}
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* Portfolios to learn from: names, not big screenshots */}
      {(view.better || view.similar.length > 0) && (
        <section aria-labelledby="compare" className="mt-7">
          <H2 id="compare">Portfolios to learn from</H2>
          <ul className="mt-1 divide-y divide-edge text-sm">
            {view.better && (
              <li className="flex items-center gap-3 py-2">
                <PublicTierBadge tier={view.better.site.tier} />
                <div className="min-w-0 flex-1">
                  <a href={view.better.site.path} className="font-semibold hover:text-accent">
                    {view.better.site.name}
                  </a>{" "}
                  <span className="text-mute">{view.better.site.domain}</span>
                  <p className="text-[13px] text-mute">
                    Better {view.better.label.toLowerCase()} ({view.better.theirs} vs {view.better.yours}){view.better.note ? `: ${view.better.note}` : "."}
                  </p>
                </div>
              </li>
            )}
            {view.similar.map((s) => (
              <li key={s.url} className="flex items-center gap-3 py-2">
                <PublicTierBadge tier={s.tier} />
                <div className="min-w-0 flex-1">
                  <a href={s.path} className="font-semibold hover:text-accent">
                    {s.name}
                  </a>{" "}
                  <span className="text-mute">{s.domain}</span>
                </div>
                <span className="shrink-0 text-xs text-mute tabular-nums">{s.topPct != null ? `Top ${s.topPct}%` : "Similar"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="mt-6 text-xs text-mute">A grade describes the page, not the developer. The measured facts are checked by code; Gemini&apos;s scores ({rep.model ?? "Gemini"}) are an opinion.</p>

      <div className="print:hidden">
        {(job.mine || claimHref) && (
          <OwnerPanel
            id={job.id}
            url={job.url}
            domain={job.domain}
            mine={job.mine}
            claimHref={claimHref}
            gradedAt={rep.gradedAt}
            regradeAfter={rep.regradeAfter}
            cooldownDays={REGRADE_COOLDOWN_DAYS}
            now={now}
            afterDelete={ROUTES.grade ? `${ROUTES.grade}?deleted=1` : "/"}
          />
        )}
        {ROUTES.play && (
          <p className="mt-8 text-center">
            <a href={ROUTES.play} className="group inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
              Think you can spot a top 10% portfolio? Play a round <ArrowRight className="nudge h-4 w-4" aria-hidden />
            </a>
          </p>
        )}
      </div>
    </article>
  );
}

/** The broken project links, one line each: the address, why it failed, and where it is on the page. */
function BrokenLinks({ links, count }: { links: GradePage["brokenLinks"]; count: number }) {
  if (!links.length)
    return count > 0 ? <p className="mt-1 text-[13px] text-mute">{count} broken; the next grade lists which ones.</p> : null;
  return (
    <ul className="mt-1.5 grid gap-1 rounded-lg border border-edge bg-raised/50 p-2.5 text-[13px]" aria-label="Broken links">
      {links.map((l) => (
        <li key={l.url} className="min-w-0">
          <span className="break-all font-mono text-[12px]">{l.url}</span>
          <span className="text-down"> · {l.reason}</span>
          {(l.text || l.section) && (
            <span className="block text-mute">
              {l.text ? `Link "${l.text}"` : "A link"}
              {l.section ? ` under "${l.section}"` : ""}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
