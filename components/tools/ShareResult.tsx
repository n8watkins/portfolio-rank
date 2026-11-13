"use client";

import { useState } from "react";
import { ArrowRight, CircleAlert, CircleCheck, ImageOff, Lightbulb, Wrench } from "lucide-react";
import type { ShareResult } from "@/lib/tools/share";

export type ShareAnswer = { url: string; listed: boolean; profile?: string; share: ShareResult; discovery: { status: string; added: boolean } | null };

const ERROR_WORDS: Record<string, string> = {
  unreachable: "We couldn't reach that address. Check that it opens in a private window.",
  http_error: "The page answered with an error, so there's no card to show.",
  not_html: "That address isn't a web page.",
};

type Platform = "linkedin" | "x" | "slack";
const PLATFORMS: { id: Platform; label: string }[] = [
  { id: "linkedin", label: "LinkedIn" },
  { id: "x", label: "X" },
  { id: "slack", label: "Slack" },
];

function CardImage({ src, className }: { src: string | null; className: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <div className={`grid place-items-center bg-raised text-mute ${className}`}>
        <span className="flex flex-col items-center gap-1.5 text-xs">
          <ImageOff className="h-5 w-5" aria-hidden /> No image
        </span>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} className={`bg-raised object-cover ${className}`} />
  );
}

const clip = (s: string | null | undefined, n: number) => (!s ? "" : s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The card as each app draws it, approximately: sizes, crops and how much text shows. */
function Preview({ share, platform }: { share: ShareResult; platform: Platform }) {
  const c = share.card!;
  const img = c.image?.loads ? c.image.url : null;
  const title = c.title || c.host;
  if (platform === "slack") {
    return (
      <div className="flex gap-3 rounded-lg bg-card p-3">
        <span className="w-1 shrink-0 rounded-full bg-edge-strong" aria-hidden />
        <div className="min-w-0">
          <p className="text-[13px] font-semibold">{c.siteName || c.host}</p>
          <p className="mt-0.5 text-[15px] font-bold text-[#1d9bd1]">{clip(title, 90)}</p>
          {c.description && <p className="mt-0.5 text-[14px] text-ink/80">{clip(c.description, 160)}</p>}
          {img && <CardImage src={img} className="mt-2 aspect-[1.91/1] w-full max-w-[360px] rounded-md" />}
        </div>
      </div>
    );
  }
  if (platform === "x") {
    if (!c.large) {
      return (
        <div className="flex overflow-hidden rounded-2xl border border-edge bg-card">
          <CardImage src={img} className="aspect-square w-28 shrink-0 border-r border-edge sm:w-32" />
          <div className="min-w-0 self-center p-3 text-[14px]">
            <p className="text-mute">{c.host}</p>
            <p className="truncate">{clip(title, 70)}</p>
            {c.description && <p className="line-clamp-2 text-mute">{c.description}</p>}
          </div>
        </div>
      );
    }
    return (
      <div className="relative overflow-hidden rounded-2xl border border-edge">
        <CardImage src={img} className="aspect-[1.91/1] w-full" />
        <span className="absolute bottom-2.5 left-2.5 max-w-[85%] truncate rounded bg-black/70 px-1.5 py-0.5 text-[13px] text-white">{clip(title, 70)}</span>
        <p className="border-t border-edge bg-card px-3 py-1.5 text-[13px] text-mute">From {c.host}</p>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-edge bg-card">
      <CardImage src={img} className="aspect-[1.91/1] w-full" />
      <div className="px-3 py-2.5">
        <p className="line-clamp-2 text-[14px] font-semibold">{clip(title, 120)}</p>
        <p className="mt-0.5 text-[12px] text-mute">{c.host}</p>
      </div>
    </div>
  );
}

/** The share preview checker's answer: the card per app, then what to fix. */
export function ShareResultView({ answer, fixHref }: { answer: ShareAnswer; fixHref?: string }) {
  const [platform, setPlatform] = useState<Platform>("linkedin");
  const s = answer.share;
  if (!s.ok || !s.card) {
    return (
      <p className="flex items-start gap-2 rounded-xl border border-edge bg-raised/50 p-4 text-sm">
        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-mute" aria-hidden />
        {ERROR_WORDS[s.error ?? ""] ?? "We couldn't read this page. Try again in a few minutes."}
      </p>
    );
  }
  const issues = s.issues ?? [];
  const fixes = issues.filter((i) => i.level === "fix");
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div>
        <div role="tablist" aria-label="App" className="inline-flex rounded-xl border border-edge bg-raised/60 p-1">
          {PLATFORMS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={platform === p.id}
              onClick={() => setPlatform(p.id)}
              className="inline-flex h-9 items-center rounded-lg px-3.5 text-sm font-medium text-mute transition hover:text-ink aria-selected:bg-card aria-selected:text-ink aria-selected:shadow-[var(--card-hi),var(--card-drop)]"
            >
              {p.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="mt-4 max-w-[480px]">
          <Preview share={s} platform={platform} />
        </div>
        <p className="mt-3 text-xs text-mute">An approximation: each app draws its own card and caches it for a few days.</p>
      </div>

      <div>
        <h3 className="text-sm font-semibold">{fixes.length ? "Fix these first" : issues.length ? "What could be better" : "Looks good"}</h3>
        {issues.length === 0 ? (
          <p className="mt-2 flex items-center gap-2 text-sm text-mute">
            <CircleCheck className="h-4 w-4 text-up" aria-hidden /> Your card has a title, a description and an image that loads. Nice work.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {issues.map((i) => (
              <li key={i.id} className="flex gap-3 rounded-xl border border-edge bg-card p-4">
                {i.level === "fix" ? <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-down" aria-hidden /> : <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />}
                <div className="min-w-0">
                  <p className="font-medium">{i.title}</p>
                  <p className="mt-1 break-words text-sm text-mute">{i.tip}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {fixHref && fixes.length > 0 && (
          <a href={fixHref} className="group mt-3 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-accent">
            See and fix it in the share preview checker <ArrowRight className="nudge h-4 w-4" aria-hidden />
          </a>
        )}
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-mute hover:text-ink">The tags we found</summary>
          <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
            {Object.entries(s.tags ?? {}).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-mono text-mute">{k}</dt>
                <dd className={`break-words ${v ? "" : "text-mute/70"}`}>{v ?? "missing"}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>
    </div>
  );
}
