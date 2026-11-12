"use client";

import { useCallback, useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { ArrowRight, BadgeCheck, CircleCheck, CircleX, Clock, Code2, EyeOff, LoaderCircle, RefreshCw, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { CopyButton } from "@/components/ui/CopyButton";
import { ScreenshotFrame } from "@/components/ui/ScreenshotFrame";
import { btnPrimary, btnSecondary } from "@/components/ui/styles";
import { useClientSession } from "@/lib/session-client";

type Claim = {
  url: string;
  status: "pending" | "verified" | "review" | "rejected";
  method: string | null;
  meta: { name: string; content: string; tag: string };
  state: { hideGrade: boolean; removedAt: string | null; removeAfter: string | null };
  /** Removal needs the meta tag or a review, not just a link (lib/games/claims.mjs removalProof). */
  removable: boolean;
};

type Step = "loading" | "signin" | "checking" | "fallback" | "verified" | "review" | "rejected" | "manage" | "remove-proof" | "confirm-remove" | "scheduled" | "removed";

/** Where a verified claim picks up: removed, a removal waiting, or the owner's options. */
const ownerStep = (c: Claim): Step => (c.state.removedAt ? "removed" : c.state.removeAfter ? "scheduled" : "manage");

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";

const STEPS = ["Sign in with GitHub", "Verify ownership", "Manage"];
const stepIndex = (s: Step) => (s === "loading" || s === "signin" ? 0 : ["checking", "fallback", "review", "rejected", "verified"].includes(s) ? 1 : 2);

async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  try {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, body: { error: "network" } };
  }
}

const ERRORS: Record<string, string> = {
  rate_limited: "That's a lot of checks in a short time. Try again in a little while.",
  not_owner: "This account isn't the verified owner of this portfolio.",
  account_too_new: "Owner actions need a GitHub account at least 30 days old. Ask through GitHub if this can't wait.",
  remove_needs_meta: "Removing your portfolio needs the meta tag on your site first.",
  hide_needs_meta: "Hiding the grade needs the meta tag on your site first.",
  network: "We couldn't reach PortfolioRank. Check your connection and try again.",
};
const errorText = (b: Record<string, unknown>) => ERRORS[String(b.error)] ?? "That didn't work. Try again in a moment.";

/**
 * Claim a listed portfolio (GAMES_V2, /api/owner/claims and
 * /api/owner/actions): sign in with GitHub; the claim is verified at once
 * when the site links to github.com/<login>, else with a meta tag (or a
 * review by hand); then the
 * owner can ask for a re-grade, hide the grade, or remove the portfolio.
 */
export function ClaimFlow({ url, name, domain, hero, regrade = true }: { url: string; name: string; domain: string; hero: string | null; /** Re-grades are offered only while the games are on (GAMES_V2). */ regrade?: boolean }) {
  const session = useClientSession();
  const [current, setStep] = useState<Step>("loading");
  const [claim, setClaim] = useState<Claim | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [confirmText, setConfirmText] = useState("");

  const check = useCallback(
    async (method: "auto" | "meta" | "manual") => {
      setBusy(true);
      setError("");
      const r = await post("/api/owner/claims", { url, method });
      setBusy(false);
      if (!r.ok) {
        setError(errorText(r.body));
        setStep((s) => (s === "checking" ? "fallback" : s));
        return;
      }
      const c = r.body.claim as Claim;
      setClaim(c);
      setStep(c.status === "verified" ? (method === "manual" ? "manage" : "verified") : c.status === "review" ? "review" : c.status === "rejected" ? "rejected" : "fallback");
      if (c.status === "pending" && method === "meta") setError("We didn't find the tag on the home page yet. Check it's inside <head> and deployed, then try again.");
      if (r.body.reason === "unreachable") setError(`We couldn't open ${domain} just now. Try again in a moment.`);
    },
    [url, domain]
  );

  // Signed in: an earlier claim picks up where it was; otherwise check at once.
  useEffect(() => {
    if (session === "loading") return;
    if (session === null) return;
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/owner/claims", { cache: "no-store" });
        const b = res.ok ? await res.json() : { claims: [] };
        const c = (b.claims as Claim[]).find((x) => x.url === url);
        if (!live) return;
        if (c?.status === "verified") {
          setClaim(c);
          setStep(ownerStep(c));
          return;
        }
        if (c?.status === "review" || c?.status === "rejected") {
          setClaim(c);
          setStep(c.status);
          return;
        }
      } catch {}
      if (!live) return;
      setStep("checking");
      void check("auto");
    })();
    return () => {
      live = false;
    };
  }, [session, url, check]);

  // A claim verified by its link adds the meta tag before it can remove the site.
  const proveForRemoval = async () => {
    setBusy(true);
    setError("");
    const r = await post("/api/owner/claims", { url, method: "meta" });
    setBusy(false);
    if (!r.ok) return setError(errorText(r.body));
    const c = r.body.claim as Claim;
    setClaim(c);
    if (c.removable) {
      setConfirmText("");
      setStep("confirm-remove");
    } else setError(r.body.reason === "unreachable" ? `We couldn't open ${domain} just now. Try again in a moment.` : "We didn't find the tag on the home page yet. Check it's inside <head> and deployed, then try again.");
  };

  const act = async (action: "regrade" | "hide_grade" | "show_grade" | "remove" | "cancel_remove") => {
    setBusy(true);
    setError("");
    setNote("");
    const r = await post("/api/owner/actions", { url, action, ...(action === "remove" ? { confirm: true } : {}) });
    setBusy(false);
    if (!r.ok) return setError(errorText(r.body));
    const state = r.body.state as Claim["state"];
    setClaim((c) => (c ? { ...c, state } : c));
    if (action === "remove" || action === "cancel_remove") setStep(ownerStep({ ...(claim as Claim), state }));
    if (action === "regrade") setNote((r.body.regrade as { queued?: boolean } | undefined)?.queued === false ? "A re-grade is already waiting for this site." : "Re-grade requested. A fresh grade follows, at most once a week.");
  };

  const login = session && session !== "loading" ? session.login : "";
  // Signed out, the first step is all there is.
  const step = session === null ? "signin" : current;
  const at = stepIndex(step);

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-10 sm:px-6 sm:py-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
      <aside className="rise">
        <div className="card overflow-hidden">
          <ScreenshotFrame src={hero} alt={`Screenshot of ${domain}`} domain={domain} eager className="w-full border-b border-edge" />
          <div className="p-4">
            <p className="font-semibold">{name}</p>
            <p className="text-sm text-mute">{domain}</p>
          </div>
        </div>
        <ol className="mt-5 grid gap-2" aria-label="Steps">
          {STEPS.map((t, k) => (
            <li key={t} aria-current={k === at ? "step" : undefined} className={`flex items-center gap-3 text-sm ${k === at ? "font-semibold" : k < at ? "text-ink" : "text-mute"}`}>
              <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold ${k < at ? "bg-up text-white" : k === at ? "bg-fill text-on-fill" : "bg-raised ring-1 ring-edge"}`}>
                {k < at ? <CircleCheck className="h-4 w-4" aria-label="Done" /> : k + 1}
              </span>
              {t}
            </li>
          ))}
        </ol>
      </aside>

      <section className="card rise p-6 sm:p-8" style={{ "--d": "80ms" } as React.CSSProperties} aria-labelledby="claim-t" aria-busy={busy || step === "loading" || step === "checking"}>
        {(step === "loading" || step === "signin") && (
          <>
            <h1 id="claim-t" className="text-2xl font-bold tracking-tight sm:text-3xl">
              Claim {domain}
            </h1>
            <p className="mt-2 text-mute">
              Claiming lets you remove your portfolio from PortfolioRank{regrade ? ", hide its grade, or ask for a re-grade" : " or hide its grade"}. We tie it to your GitHub
              account, the same way removal requests already work.
            </p>
            <button
              type="button"
              disabled={step === "loading"}
              onClick={() => signIn("github", { callbackUrl: location.href })}
              className="mt-6 inline-flex h-12 items-center gap-2 rounded-lg bg-ink px-5 text-[15px] font-semibold text-bg transition hover:opacity-90 disabled:opacity-60"
            >
              <svg viewBox="0 0 16 16" className="h-5 w-5 fill-current" aria-hidden>
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
              </svg>
              Continue with GitHub
            </button>
            <h2 className="mt-8 text-sm font-semibold">How we check it&apos;s yours</h2>
            <ul className="mt-2 grid gap-2 text-sm text-mute">
              <li className="flex gap-2">
                <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink" aria-hidden /> Your site links to your GitHub profile.
              </li>
              <li className="flex gap-2">
                <Code2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> Neither? Add a one-line meta tag to your site.
              </li>
            </ul>
          </>
        )}

        {step === "checking" && (
          <>
            <p className="text-sm text-mute">Signed in as @{login}</p>
            <h1 id="claim-t" className="mt-1 flex items-center gap-3 text-2xl font-bold tracking-tight sm:text-3xl">
              <LoaderCircle className="h-6 w-6 animate-spin text-mute" aria-hidden /> Checking {domain}
            </h1>
            <p className="mt-2 text-mute">Looking for a link to github.com/{login} on the page.</p>
          </>
        )}

        {(step === "verified" || step === "fallback") && (
          <>
            <p className="text-sm text-mute">Signed in as @{login}</p>
            <h1 id="claim-t" className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
              {step === "verified" ? "You're verified" : "We couldn't verify it automatically"}
            </h1>
            <ul className="mt-5 grid gap-3">
              {[
                {
                  ok: claim?.method === "github_link",
                  t: `${domain} links to github.com/${login}`,
                  d: claim?.method === "github_link" ? "Found in the page's links." : step === "verified" ? "Not needed: one check is enough." : `No link to github.com/${login} on the page.`,
                },
                ...(claim?.method === "meta" ? [{ ok: true, t: "The meta tag is on the home page", d: "You can remove it now." }] : []),
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
            {step === "verified" ? (
              <button type="button" onClick={() => setStep("manage")} className={`${btnPrimary} mt-6`}>
                Manage your portfolio <ArrowRight className="nudge h-4 w-4" aria-hidden />
              </button>
            ) : (
              claim && (
                <div className="mt-6 rounded-xl border border-edge p-5">
                  <p className="flex items-center gap-2 font-semibold">
                    <Code2 className="h-4 w-4 text-mute" aria-hidden /> Verify with a meta tag
                  </p>
                  <p className="mt-1 text-sm text-mute">
                    Add this line inside the &lt;head&gt; of {domain}&apos;s home page, deploy, then check again. The token is unique to you and this site.
                  </p>
                  <pre className="mt-3 overflow-x-auto rounded-lg bg-raised p-3 font-mono text-[12.5px]">{claim.meta.tag}</pre>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <CopyButton text={claim.meta.tag} label="Copy tag" />
                    <button type="button" disabled={busy} onClick={() => check("meta")} className="group btn-sheen inline-flex h-11 items-center gap-1.5 rounded-lg bg-fill px-4 text-sm font-semibold text-on-fill sm:h-9">
                      <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} aria-hidden /> Check again
                    </button>
                  </div>
                  <p className="mt-3 text-xs text-mute">
                    You can remove the tag once you&apos;re verified. Can&apos;t edit the site?{" "}
                    <button type="button" disabled={busy} onClick={() => check("manual")} className="font-semibold text-ink underline decoration-edge-strong underline-offset-4 hover:decoration-accent">
                      Ask for a review
                    </button>
                  </p>
                </div>
              )
            )}
          </>
        )}

        {(step === "review" || step === "rejected") && (
          <>
            <span className="grid h-12 w-12 place-items-center rounded-xl bg-raised text-mute">
              <Clock className="h-6 w-6" aria-hidden />
            </span>
            <h1 id="claim-t" className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">
              {step === "review" ? "Waiting for a review" : "This claim wasn't accepted"}
            </h1>
            <p className="mt-2 text-mute">
              {step === "review"
                ? `The site's owner checks claims by hand. Once yours is accepted, this page lets you manage ${domain}.`
                : `The review found no proof that ${domain} is yours. Add the meta tag and check again, or ask through GitHub.`}
            </p>
            {step === "rejected" && claim && (
              <pre className="mt-4 overflow-x-auto rounded-lg bg-raised p-3 font-mono text-[12.5px]">{claim.meta.tag}</pre>
            )}
          </>
        )}

        {step === "manage" && claim && (
          <>
            <p className="inline-flex items-center gap-1.5 rounded-full bg-up/10 px-2.5 py-1 text-xs font-semibold text-up">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Owner verified · @{login}
            </p>
            <h1 id="claim-t" className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
              Manage {domain}
            </h1>
            <ul className="mt-6 grid gap-3">
              {regrade && (
                <li className="flex flex-wrap items-center gap-4 rounded-xl border border-edge p-4">
                  <RefreshCw className="h-5 w-5 shrink-0 text-mute" aria-hidden />
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block font-semibold">Request a re-grade</span>
                    <span className="block text-mute">After a change to your site. Once a week at most.</span>
                  </span>
                  <button type="button" disabled={busy} onClick={() => act("regrade")} className={btnSecondary}>
                    Re-grade
                  </button>
                </li>
              )}
              <li className="flex flex-wrap items-center gap-4 rounded-xl border border-edge p-4">
                <EyeOff className="h-5 w-5 shrink-0 text-mute" aria-hidden />
                <span className="min-w-0 flex-1 text-sm">
                  <span id="hide-label" className="block font-semibold">
                    Hide the grade
                  </span>
                  <span className="block text-mute">
                    {claim.removable ? "Your site stays listed and in face-offs; the tier and report are hidden from others." : "Your site stays listed and in face-offs; the tier and report are hidden from others. First, add a meta tag to your site."}
                  </span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={claim.state.hideGrade}
                  aria-labelledby="hide-label"
                  disabled={busy}
                  onClick={() => {
                    if (!claim.removable) {
                      setError("");
                      setStep("remove-proof");
                      return;
                    }
                    void act(claim.state.hideGrade ? "show_grade" : "hide_grade");
                  }}
                  className={`relative grid h-11 w-14 shrink-0 place-items-center disabled:opacity-60`}
                >
                  <span className={`relative h-6 w-11 rounded-full transition ${claim.state.hideGrade ? "bg-up" : "bg-edge-strong"}`}>
                    <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-card shadow transition-[left] ${claim.state.hideGrade ? "left-[1.375rem]" : "left-0.5"}`} />
                  </span>
                </button>
              </li>
              <li className="flex flex-wrap items-center gap-4 rounded-xl border border-down/40 p-4">
                <Trash2 className="h-5 w-5 shrink-0 text-down" aria-hidden />
                <span className="min-w-0 flex-1 text-sm">
                  <span className="block font-semibold">Remove from PortfolioRank</span>
                  <span className="block text-mute">
                    {claim.removable ? "Takes it off the leaderboard, games and browse, for good, a day after you ask." : "Takes it off the leaderboard, games and browse, for good. First, add a meta tag to your site."}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmText("");
                    setError("");
                    setStep(claim.removable ? "confirm-remove" : "remove-proof");
                  }}
                  className="inline-flex h-11 items-center rounded-lg border border-down/50 px-4 text-sm font-semibold text-down transition hover:bg-down/10"
                >
                  Remove
                </button>
              </li>
            </ul>
            {note && (
              <p role="status" className="mt-4 text-sm text-up">
                {note}
              </p>
            )}
          </>
        )}

        {step === "remove-proof" && claim && (
          <>
            <span className="grid h-12 w-12 place-items-center rounded-xl bg-raised text-mute">
              <Code2 className="h-6 w-6" aria-hidden />
            </span>
            <h1 id="claim-t" className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">
              One more check: prove {domain} is yours
            </h1>
            <p className="mt-2 text-mute">
              A link to your GitHub profile is enough to ask for a re-grade, but sites link collaborators&apos; and template authors&apos; profiles too. Hiding the grade or removing the site asks for proof only its owner can add: put this line inside the &lt;head&gt; of {domain}&apos;s home page, deploy, then check.
            </p>
            <pre className="mt-4 overflow-x-auto rounded-lg bg-raised p-3 font-mono text-[12.5px]">{claim.meta.tag}</pre>
            <div className="mt-4 flex flex-wrap gap-2">
              <CopyButton text={claim.meta.tag} label="Copy tag" />
              <button type="button" disabled={busy} onClick={proveForRemoval} className="group btn-sheen inline-flex h-11 items-center gap-1.5 rounded-lg bg-fill px-4 text-sm font-semibold text-on-fill sm:h-9">
                <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} aria-hidden /> Check the tag
              </button>
              <button type="button" onClick={() => setStep("manage")} className={btnSecondary}>
                Back
              </button>
            </div>
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
                "It's removed 24 hours from now. Until then you can cancel it here.",
                "It then leaves the leaderboard, face-offs, quizzes and browse.",
                "It's added to our exclusion list, so it won't come back from the community list.",
                "The removed page counts it as removed at the owner's request, with no other details.",
              ].map((t) => (
                <li key={t} className="flex gap-2">
                  <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-mute" aria-hidden /> {t}
                </li>
              ))}
            </ul>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (confirmText.trim().toLowerCase() === domain.toLowerCase()) void act("remove");
              }}
            >
              <label htmlFor="confirm" className="mt-6 block text-sm font-medium">
                Type <strong>{domain}</strong> to confirm
              </label>
              <input
                id="confirm"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="mt-1.5 h-11 w-full max-w-sm rounded-lg border border-edge bg-card px-3 text-sm outline-none focus:border-down"
              />
              <div className="mt-5 flex flex-wrap gap-2">
                <button
                  type="submit"
                  disabled={busy || confirmText.trim().toLowerCase() !== domain.toLowerCase()}
                  className="inline-flex h-11 items-center gap-2 rounded-lg bg-down px-5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" aria-hidden /> Remove my portfolio
                </button>
                <button type="button" onClick={() => setStep("manage")} className={btnSecondary}>
                  Keep it
                </button>
              </div>
            </form>
          </>
        )}

        {step === "scheduled" && claim && (
          <>
            <span className="grid h-12 w-12 place-items-center rounded-xl bg-raised text-mute">
              <Clock className="h-6 w-6" aria-hidden />
            </span>
            <h1 id="claim-t" className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">
              {domain} will be removed
            </h1>
            <p className="mt-2 text-mute">
              It leaves PortfolioRank on {when(claim.state.removeAfter)}, then joins our exclusion list. Changed your mind? Cancel before then.
            </p>
            <button type="button" disabled={busy} onClick={() => act("cancel_remove")} className={`${btnSecondary} mt-6`}>
              Keep {domain} listed
            </button>
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
            <p className="mt-2 text-mute">It&apos;s gone from PortfolioRank and joins our exclusion list this week. The removed page counts it as removed at the owner&apos;s request.</p>
            <a href="/removed" className={`${btnSecondary} mt-6`}>
              See the removed page
            </a>
          </>
        )}

        {error && (
          <p role="alert" className="mt-4 text-sm text-down">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
