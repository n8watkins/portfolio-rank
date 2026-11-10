import { notFound } from "next/navigation";
import { ArrowRight, BadgeCheck, CircleCheck, CircleX, Code2, EyeOff, LifeBuoy, RefreshCw, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { Shot } from "@/components/preview/Shot";
import { SampleTag, btnPrimary, btnSecondary } from "@/components/preview/bits";
import { siteBySlug } from "@/lib/preview/data";
import { visitor } from "@/lib/preview/visitor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Claim your portfolio - PortfolioRank" };

const STEPS = ["Sign in with GitHub", "Verify ownership", "Manage"];
type Step = "signin" | "verify" | "fallback" | "verified" | "confirm-remove" | "removed";

/**
 * Claim a portfolio (preview, sample data). Ownership is verified
 * automatically when the site links to github.com/<login> or the GitHub
 * profile's Website field points at the site's domain; otherwise a meta tag
 * or a manual review. A claimed site can be removed, its grade hidden, or a
 * re-grade requested.
 */
export default async function ClaimPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ state?: string; step?: string }> }) {
  const sp = await searchParams;
  const v = await visitor(sp);
  const site = siteBySlug((await params).slug);
  if (!site) notFound();
  const step = (["signin", "verify", "fallback", "verified", "confirm-remove", "removed"].includes(sp.step ?? "") ? sp.step : "signin") as Step;
  const login = "jordan-dev";
  const at = step === "signin" ? 0 : step === "verify" || step === "fallback" ? 1 : 2;
  const href = (s: Step) => `/claim/${site.slug}?step=${s}`;
  const domain = site.domain.split("/")[0];

  return (
    <AppShell visitor={v} current="other">
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 py-10 sm:py-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        {/* The site being claimed */}
        <aside className="rise">
          <div className="card overflow-hidden">
            <Shot base={site.shot} alt={`Screenshot of ${site.domain}`} domain={site.domain} className="aspect-[16/10] w-full border-b border-edge" />
            <div className="p-4">
              <p className="font-semibold">{site.name}</p>
              <p className="text-sm text-mute">{site.domain}</p>
            </div>
          </div>
          <ol className="mt-5 grid gap-2" aria-label="Steps">
            {STEPS.map((t, k) => (
              <li key={t} className={`flex items-center gap-3 text-sm ${k === at ? "font-semibold" : k < at ? "text-ink" : "text-mute"}`}>
                <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold ${k < at ? "bg-up text-white" : k === at ? "bg-fill text-on-fill" : "bg-raised ring-1 ring-edge"}`}>
                  {k < at ? <CircleCheck className="h-4 w-4" aria-hidden /> : k + 1}
                </span>
                {t}
              </li>
            ))}
          </ol>
          <p className="mt-5 flex items-center gap-2 text-xs text-mute">
            <SampleTag what="Claim flow" /> No real accounts or checks run in the preview.
          </p>
        </aside>

        <section className="card rise p-6 sm:p-8" style={{ "--d": "80ms" } as React.CSSProperties} aria-labelledby="claim-t">
          {step === "signin" && (
            <>
              <h1 id="claim-t" className="text-2xl font-bold tracking-tight sm:text-3xl">
                Claim {domain}
              </h1>
              <p className="mt-2 text-mute">
                Claiming lets you remove your portfolio from PortfolioRank, hide its grade, or ask for a re-grade. We tie it to your GitHub account, the same way removal
                requests already work.
              </p>
              <a href={href("verify")} className="mt-6 inline-flex h-12 items-center gap-2 rounded-lg bg-ink px-5 text-[15px] font-semibold text-bg transition hover:opacity-90">
                <svg viewBox="0 0 16 16" className="h-5 w-5 fill-current" aria-hidden>
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                </svg>
                Continue with GitHub
              </a>
              <h2 className="mt-8 text-sm font-semibold">How we check it&apos;s yours</h2>
              <ul className="mt-2 grid gap-2 text-sm text-mute">
                <li className="flex gap-2">
                  <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink" aria-hidden /> Your site links to your GitHub profile, or
                </li>
                <li className="flex gap-2">
                  <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink" aria-hidden /> your GitHub profile&apos;s Website field points to {domain}.
                </li>
                <li className="flex gap-2">
                  <LifeBuoy className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> Neither? Add a small meta tag, or ask for a manual review.
                </li>
              </ul>
            </>
          )}

          {(step === "verify" || step === "fallback") && (
            <>
              <p className="text-sm text-mute">Signed in as @{login}</p>
              <h1 id="claim-t" className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
                {step === "verify" ? "You're verified" : "We couldn't verify it automatically"}
              </h1>
              <ul className="mt-5 grid gap-3">
                {[
                  { ok: step === "verify", t: `${domain} links to github.com/${login}`, d: step === "verify" ? "Found in the page's links." : `No link to github.com/${login} on the page.` },
                  { ok: false, t: `GitHub profile Website points to ${domain}`, d: step === "verify" ? "Not needed: one check is enough." : "Your profile's Website field is empty." },
                ].map((c) => (
                  <li key={c.t} className="flex items-start gap-3 rounded-xl border border-edge bg-bg/40 p-3.5 text-sm">
                    {c.ok ? <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-up" aria-label="Passed" /> : <CircleX className="mt-0.5 h-5 w-5 shrink-0 text-mute" aria-label="Not found" />}
                    <span>
                      <span className="block font-semibold">{c.t}</span>
                      <span className="block text-mute">{c.d}</span>
                    </span>
                  </li>
                ))}
              </ul>
              {step === "verify" ? (
                <a href={href("verified")} className={`${btnPrimary} mt-6`}>
                  Manage your portfolio <ArrowRight className="nudge h-4 w-4" aria-hidden />
                </a>
              ) : (
                <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="rounded-xl border border-edge p-4">
                    <p className="flex items-center gap-2 font-semibold">
                      <Code2 className="h-4 w-4 text-mute" aria-hidden /> Add a meta tag
                    </p>
                    <p className="mt-1 text-sm text-mute">Put this in your site&apos;s &lt;head&gt;, deploy, then check again.</p>
                    <pre className="mt-3 overflow-x-auto rounded-lg bg-raised p-3 font-mono text-[12px]">{`<meta name="portfoliorank-verify" content="pr-7f3a9c" />`}</pre>
                    <a href={href("verify")} className={`${btnSecondary} mt-3`}>
                      <RefreshCw className="h-4 w-4" aria-hidden /> Check again
                    </a>
                  </div>
                  <div className="rounded-xl border border-edge p-4">
                    <p className="flex items-center gap-2 font-semibold">
                      <LifeBuoy className="h-4 w-4 text-mute" aria-hidden /> Ask for a manual review
                    </p>
                    <p className="mt-1 text-sm text-mute">Tell us how we can confirm it&apos;s yours. A person replies within a few days.</p>
                    <label htmlFor="why" className="sr-only">
                      How we can confirm it&apos;s yours
                    </label>
                    <textarea id="why" rows={3} placeholder="For example: the email on my site is..." className="mt-3 w-full rounded-lg border border-edge bg-card p-2.5 text-sm outline-none focus:border-accent" />
                    <button type="button" className={`${btnSecondary} mt-2`}>
                      Send for review
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {step === "verified" && (
            <>
              <p className="inline-flex items-center gap-1.5 rounded-full bg-up/10 px-2.5 py-1 text-xs font-semibold text-up">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Owner verified · @{login}
              </p>
              <h1 id="claim-t" className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
                Manage {domain}
              </h1>
              <ul className="mt-6 grid gap-3">
                <li className="flex flex-wrap items-center gap-4 rounded-xl border border-edge p-4">
                  <RefreshCw className="h-5 w-5 shrink-0 text-mute" aria-hidden />
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block font-semibold">Request a re-grade</span>
                    <span className="block text-mute">Owners can re-grade any time after a change.</span>
                  </span>
                  <a href={`/grade?url=${encodeURIComponent(site.url)}`} className={btnSecondary}>
                    Re-grade now
                  </a>
                </li>
                <li className="flex flex-wrap items-center gap-4 rounded-xl border border-edge p-4">
                  <EyeOff className="h-5 w-5 shrink-0 text-mute" aria-hidden />
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block font-semibold">Hide the grade</span>
                    <span className="block text-mute">Your site stays listed and in face-offs; the tier and report are hidden from others.</span>
                  </span>
                  <span role="switch" aria-checked="false" aria-label="Hide the grade" className="relative h-6 w-11 shrink-0 rounded-full bg-edge-strong">
                    <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-card shadow" />
                  </span>
                </li>
                <li className="flex flex-wrap items-center gap-4 rounded-xl border border-down/40 p-4">
                  <Trash2 className="h-5 w-5 shrink-0 text-down" aria-hidden />
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block font-semibold">Remove from PortfolioRank</span>
                    <span className="block text-mute">Takes it off the leaderboard, games and browse, for good.</span>
                  </span>
                  <a href={href("confirm-remove")} className="inline-flex h-11 items-center rounded-lg border border-down/50 px-4 text-sm font-semibold text-down transition hover:bg-down/10">
                    Remove
                  </a>
                </li>
              </ul>
            </>
          )}

          {step === "confirm-remove" && (
            <>
              <span className="grid h-12 w-12 place-items-center rounded-xl bg-down/10 text-down">
                <TriangleAlert className="h-6 w-6" aria-hidden />
              </span>
              <h1 id="claim-t" className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">
                Remove {domain} from PortfolioRank?
              </h1>
              <ul className="mt-4 grid gap-2 text-sm">
                {[
                  "It leaves the leaderboard, face-offs, quizzes and browse.",
                  "Its grades, votes and screenshots are deleted.",
                  "It's added to our exclusion list, so it won't come back from the community list.",
                  "The removed page lists it as “removed at the owner's request”, with no other details.",
                ].map((t) => (
                  <li key={t} className="flex gap-2">
                    <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-mute" aria-hidden /> {t}
                  </li>
                ))}
              </ul>
              <label htmlFor="confirm" className="mt-6 block text-sm font-medium">
                Type <strong>{domain}</strong> to confirm
              </label>
              <input id="confirm" defaultValue={domain} className="mt-1.5 h-11 w-full max-w-sm rounded-lg border border-edge bg-card px-3 text-sm outline-none focus:border-down" />
              <div className="mt-5 flex flex-wrap gap-2">
                <a href={href("removed")} className="inline-flex h-11 items-center gap-2 rounded-lg bg-down px-5 text-sm font-semibold text-white transition hover:opacity-90">
                  <Trash2 className="h-4 w-4" aria-hidden /> Remove my portfolio
                </a>
                <a href={href("verified")} className={btnSecondary}>
                  Keep it
                </a>
              </div>
            </>
          )}

          {step === "removed" && (
            <>
              <span className="grid h-12 w-12 place-items-center rounded-xl bg-up/10 text-up">
                <CircleCheck className="h-6 w-6" aria-hidden />
              </span>
              <h1 id="claim-t" className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">
                {domain} is removed
              </h1>
              <p className="mt-2 text-mute">
                It&apos;s gone from PortfolioRank and on our exclusion list. On the removed page it shows as &ldquo;removed at the owner&apos;s request&rdquo;.
              </p>
              <a href="/removed" className={`${btnSecondary} mt-6`}>
                See the removed page
              </a>
            </>
          )}
        </section>
      </div>
    </AppShell>
  );
}
