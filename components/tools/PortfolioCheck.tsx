"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, CircleCheck, Gauge, Link2, ListChecks, Loader2, RotateCw, Search, Share2, Sparkles, Trophy } from "lucide-react";
import { ROUTES } from "@/lib/nav";
import { TOOLS, type ToolId } from "@/lib/tools/catalog";
import { btnPrimary, btnSecondary } from "@/components/ui/styles";
import { useToolRequest } from "@/components/tools/useToolRequest";
import { SpeedResult, type SpeedAnswer } from "@/components/tools/SpeedResult";
import { ShareResultView, type ShareAnswer } from "@/components/tools/ShareResult";
import { ChecklistResult, type ChecklistAnswer } from "@/components/tools/ChecklistResult";

const LOOKS_LIKE_URL = /^(https?:\/\/)?[^\s./]+\.[^\s]{2,}$/;

/** Where each tool posts. */
const ENDPOINT: Record<ToolId, string> = { speed: "/api/tools/speed", share: "/api/tools/share-preview", checklist: "/api/tools/checklist" };

/** The fast checks first, so their results show while Lighthouse runs. */
const ORDER: ToolId[] = ["checklist", "share", "speed"];

const STEPS: Record<ToolId, string[]> = {
  checklist: ["Checking resume, GitHub, contact and project links"],
  share: ["Reading your share card"],
  speed: ["Loading your site on a phone and a desktop", "Scoring speed, accessibility and SEO"],
};

const ICON: Record<ToolId, typeof Gauge> = { speed: Gauge, share: Share2, checklist: ListChecks };
const HEADING: Record<ToolId, string> = { checklist: "Portfolio checklist", share: "Share preview", speed: "Speed and Lighthouse" };

type Answer = { url: string; listed: boolean; profile?: string; discovery: { status: string; added: boolean } | null };
type Answers = Partial<Record<ToolId, Answer>>;

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The wait, told honestly: what's happening and how long it has been. */
function Running({ tools, since }: { tools: ToolId[]; since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  const steps = tools.flatMap((t) => STEPS[t]);
  const at = Math.min(steps.length - 1, Math.floor(secs / (50 / steps.length)));
  return (
    <div role="status" aria-live="polite" className="card p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 font-semibold">
          <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden /> Checking your portfolio
        </p>
        <span className="text-sm tabular-nums text-mute">{secs}s</span>
      </div>
      <ol className="mt-4 space-y-2.5">
        {steps.map((s, i) => (
          <li key={s} className={`flex items-center gap-2.5 text-sm transition ${i <= at ? "text-ink" : "text-mute/70"}`}>
            {i < at ? <CircleCheck className="h-4 w-4 text-up" aria-hidden /> : <span className={`mx-1 h-2 w-2 rounded-full ${i === at ? "attn-dot bg-accent" : "bg-edge-strong"}`} aria-hidden />}
            {s}
          </li>
        ))}
      </ol>
      {tools.includes("speed") && <p className="mt-4 text-xs text-mute">Lighthouse loads the whole page twice, so the speed check takes about a minute.</p>}
    </div>
  );
}

/** What happened to the results: saved to a listed profile, or in line to join PortfolioRank. */
function Saved({ answer }: { answer: Answer }) {
  const host = hostOf(answer.url);
  if (answer.listed && answer.profile) {
    return (
      <p className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <CircleCheck className="h-4 w-4 shrink-0 text-up" aria-hidden />
        <span>
          <span className="font-semibold">{host}</span> is on PortfolioRank. These results are saved to its profile.
        </span>
        <a href={answer.profile} className="group inline-flex items-center gap-1 font-semibold text-accent">
          See the profile <ArrowRight className="nudge h-4 w-4" aria-hidden />
        </a>
      </p>
    );
  }
  if (answer.discovery) {
    return (
      <p className="flex items-start gap-3 text-sm">
        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-up" aria-hidden />
        <span>
          <span className="font-semibold">{host}</span> {answer.discovery.added ? "is now in line to join PortfolioRank" : "is in line to join PortfolioRank"}. We grade it when there&apos;s room
          in the day&apos;s free quota; it stays private until then.
        </span>
      </p>
    );
  }
  return null;
}

/**
 * One address, every tool in `tools`, one run: the fast checks first, each
 * result shown as it arrives. Results are saved (lib/tools): to a listed
 * portfolio's profile, or with the site's place in line to join
 * PortfolioRank. With more than one tool, each failed item links to its
 * tool, where it can be fixed and tested again.
 */
export function PortfolioCheck({ tools, initialUrl = "", cta = "Check my portfolio" }: { tools: ToolId[]; initialUrl?: string; cta?: string }) {
  const id = useId();
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState("");
  const [since, setSince] = useState<number | null>(null);
  const [pending, setPending] = useState<ToolId[]>([]);
  const [answers, setAnswers] = useState<Answers>({});
  const [checked, setChecked] = useState("");
  const results = useRef<HTMLDivElement>(null);
  const { arm, post, turnstile, needsTick } = useToolRequest();
  const busy = since !== null;
  const order = ORDER.filter((t) => tools.includes(t));
  const linkTools = order.length > 1;

  const run = async (raw: string, fresh = false) => {
    const v = raw.trim();
    if (!LOOKS_LIKE_URL.test(v)) {
      setError("Paste your portfolio's address, like yourname.dev.");
      return;
    }
    setError("");
    setAnswers({});
    setChecked(v);
    setSince(Date.now());
    setPending(order);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("url", v);
      window.history.replaceState(null, "", u);
    } catch {}
    try {
      // One Turnstile token per request, so the tools run one after another.
      for (const t of order) {
        const r = await post<Answer>(ENDPOINT[t], { url: v, ...(fresh ? { fresh: true } : {}) });
        setPending((p) => p.filter((x) => x !== t));
        if (!r.ok) {
          setError(r.message);
          break;
        }
        setAnswers((a) => ({ ...a, [t]: r.data }));
        if (t === order[0]) requestAnimationFrame(() => results.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
      }
    } finally {
      setSince(null);
      setPending([]);
    }
  };

  const first = order.map((t) => answers[t]).find(Boolean);
  const gradeHref = ROUTES.grade ? `${ROUTES.grade}?url=${encodeURIComponent(checked)}` : ROUTES.top;
  const toolOf = (t: ToolId) => TOOLS.find((x) => x.id === t)!;

  return (
    <div>
      <form
        noValidate
        onFocus={arm}
        onPointerEnter={arm}
        onSubmit={(e) => {
          e.preventDefault();
          void run(url);
        }}
        aria-busy={busy}
        className="w-full"
      >
        <label htmlFor={`${id}-url`} className="sr-only">
          Your portfolio address
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Link2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-mute" aria-hidden />
            <input
              id={`${id}-url`}
              type="url"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              placeholder="yourname.dev"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError("");
              }}
              aria-invalid={!!error}
              aria-describedby={`${id}-note${error ? ` ${id}-error` : ""}`}
              className="h-12 w-full rounded-lg border border-edge bg-card pl-10 pr-3 text-[15px] outline-none transition placeholder:text-mute/80 focus:border-accent"
            />
          </div>
          <button type="submit" disabled={busy} className={`${btnPrimary} h-12 px-6 text-[15px]`}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Search className="h-4 w-4" aria-hidden />}
            {busy ? "Checking" : cta}
          </button>
        </div>
        {error && (
          <p id={`${id}-error`} role="alert" className="mt-2 text-sm text-down">
            {error}
          </p>
        )}
        <p id={`${id}-note`} className="mt-2.5 text-xs text-mute">
          Free, no account. A site we can load is added to PortfolioRank and stays private until it&apos;s graded.
        </p>
        {turnstile}
        {needsTick && (
          <p role="status" className="mt-2 text-sm font-medium">
            Cloudflare wants a quick check first: tick the box{busy ? " and the check starts" : ""}.
          </p>
        )}
      </form>

      <div ref={results} className="scroll-mt-24 space-y-6 text-left">
        {order.map((t) => {
          const a = answers[t];
          if (!a) return null;
          const Icon = ICON[t];
          const tool = toolOf(t);
          return (
            <section key={t} aria-labelledby={`${id}-${t}`} className="card mt-6 p-5 first:mt-10 sm:p-7">
              <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="icon-tile h-10 w-10">
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <h2 id={`${id}-${t}`} className="text-lg font-bold tracking-tight">
                      {HEADING[t]}
                    </h2>
                    <p className="truncate text-sm text-mute">{hostOf(a.url)}</p>
                  </div>
                </div>
                {linkTools && (
                  <a href={`${tool.href}?url=${encodeURIComponent(checked)}`} className="group inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-accent">
                    Open the {tool.short} <ArrowRight className="nudge h-4 w-4" aria-hidden />
                  </a>
                )}
              </div>
              {t === "speed" && <SpeedResult answer={a as SpeedAnswer} />}
              {t === "share" && <ShareResultView answer={a as ShareAnswer} fixHref={linkTools ? `${tool.href}?url=${encodeURIComponent(checked)}` : undefined} />}
              {t === "checklist" && <ChecklistResult answer={a as ChecklistAnswer} />}
            </section>
          );
        })}
        {busy && since !== null && !needsTick && pending.length > 0 && (
          <div className={first ? "mt-6" : "mt-8"}>
            <Running tools={pending} since={since} />
          </div>
        )}
        {first && !busy && (
          <div className="card mt-6 flex flex-col gap-4 p-5 sm:p-6">
            <div className="min-w-0">
              <Saved answer={first} />
              <p className="mt-2 flex items-start gap-3 text-sm text-mute">
                <Trophy className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
                These are the basics. Get a full grade, see where you&apos;d rank among real developer portfolios, and the three things to fix first.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <a href={gradeHref ?? "/top"} className={btnPrimary}>
                <Sparkles className="h-4 w-4" aria-hidden /> Grade my whole portfolio
              </a>
              <button type="button" onClick={() => void run(checked, true)} className={btnSecondary} title="Measure again now, after a fix">
                <RotateCw className="h-4 w-4" aria-hidden /> Check again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
