"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Vote } from "lucide-react";
import { PollBar } from "@/components/home/PollBar";
import { Turnstile, type TurnstileHandle } from "@/components/ui/Turnstile";
import type { PublicPoll } from "@/lib/polls/server";

const closesOn = (iso: string) =>
  // closesAt is the first moment it's closed: the day before is its last.
  new Date(Date.parse(iso) - 1).toLocaleDateString("en-US", { weekday: "long", timeZone: "America/Los_Angeles" });

/**
 * This week's poll (app/api/polls). One vote per visitor, no sign-in: the
 * server keys it on the browser and the account. The card asks for this
 * visitor's vote once it scrolls into view, so the cached page stays the
 * same for everyone.
 */
export function PollCard({ poll: initial }: { poll: PublicPoll }) {
  const [poll, setPoll] = useState(initial);
  const [mine, setMine] = useState<number | null>(null);
  const [needsCheck, setNeedsCheck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const box = useRef<HTMLElement>(null);
  const token = useRef<string | null>(null);
  const widget = useRef<TurnstileHandle>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let done = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (done || !entries.some((e) => e.isIntersecting)) return;
        done = true;
        io.disconnect();
        fetch(`/api/polls/${poll.id}/vote`)
          .then((r) => (r.ok ? r.json() : null))
          .then((b: { mine: number | null; turnstile: boolean } | null) => {
            if (!b) return;
            if (typeof b.mine === "number") setMine(b.mine);
            setNeedsCheck(Boolean(b.turnstile));
          })
          .catch(() => {});
      },
      { rootMargin: "200px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [poll.id]);

  const vote = async (option: number) => {
    setBusy(true);
    setError("");
    try {
      if (needsCheck) for (let k = 0; k < 30 && !token.current; k++) await new Promise((r) => setTimeout(r, 150));
      const res = await fetch(`/api/polls/${poll.id}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ option, ...(token.current ? { turnstileToken: token.current } : {}) }),
      });
      token.current = null;
      widget.current?.reset();
      const b = (await res.json().catch(() => ({}))) as { mine?: number; poll?: PublicPoll; error?: string };
      if (b.poll) setPoll(b.poll);
      if (typeof b.mine === "number") setMine(b.mine);
      else if (b.error === "closed") setError("This poll just closed.");
      else if (!res.ok) setError("Your vote didn't go through. Try again in a moment.");
    } catch {
      setError("Your vote didn't go through. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const voted = mine !== null;
  const max = Math.max(...poll.options.map((o) => o.votes));

  return (
    <section ref={box} aria-labelledby={`poll-${poll.id}`} className="card flex h-full flex-col p-5 sm:p-6">
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-mute">
        <Vote className="h-4 w-4" aria-hidden /> Poll of the week
      </p>
      <h3 id={`poll-${poll.id}`} className="mt-2 text-xl font-bold tracking-tight text-balance">
        {poll.question}
      </h3>
      {poll.detail && <p className="mt-1 text-sm text-mute">{poll.detail}</p>}

      {poll.kind === "hero" ? (
        <div className="mt-4 grid flex-1 grid-cols-2 gap-3">
          {poll.options.map((o) => (
            <button
              key={o.index}
              type="button"
              disabled={voted || busy}
              onClick={() => vote(o.index)}
              aria-pressed={mine === o.index}
              aria-label={voted ? `${o.label}: ${o.percent}%, ${o.votes} votes` : `Vote for ${o.label}${o.site ? `, ${o.site.domain}` : ""}`}
              className={`group relative flex flex-col overflow-hidden rounded-xl border bg-raised text-left transition disabled:cursor-default ${
                mine === o.index ? "border-accent ring-2 ring-accent" : voted ? "border-edge" : "card-hover border-edge hover:border-edge-strong"
              }`}
            >
              <span className="relative block aspect-[16/10] w-full">
                {o.site?.hero && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={o.site.hero} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover object-top" />
                )}
                {voted && (
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/55 to-transparent p-3 pt-8 text-white">
                    {mine === o.index && (
                      <span className="mb-1 inline-flex items-center gap-1 rounded-full bg-fill px-2 py-0.5 text-[11px] font-bold text-on-fill">
                        <Check className="h-3 w-3" aria-hidden /> Your vote
                      </span>
                    )}
                    <span className="block text-2xl font-bold tabular-nums">{o.percent}%</span>
                    <span className="block text-xs text-white/80">{o.votes.toLocaleString("en-US")} votes</span>
                  </span>
                )}
              </span>
              <span className="flex items-center justify-between gap-2 border-t border-edge bg-card px-3 py-2 text-sm">
                <span className="min-w-0 truncate">
                  <span className="font-semibold">{o.label}</span> {o.site && <span className="text-mute">{o.site.domain}</span>}
                </span>
                {!voted && <span className="shrink-0 text-xs font-semibold text-accent">Vote</span>}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-4 grid flex-1 content-start gap-3">
          {poll.options.map((o) =>
            voted ? (
              <PollBar key={o.index} label={o.label} votes={o.votes} pct={o.percent} lead={o.votes === max && max > 0} mine={mine === o.index} />
            ) : (
              <button
                key={o.index}
                type="button"
                disabled={busy}
                onClick={() => vote(o.index)}
                className="card-hover h-11 rounded-lg border border-edge bg-card px-4 text-left text-sm font-semibold"
              >
                {o.label}
              </button>
            )
          )}
        </div>
      )}

      {needsCheck && !voted && (
        <Turnstile ref={widget} action="poll-vote" onToken={(t) => (token.current = t)} onExpire={() => (token.current = null)} className="empty:hidden" />
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-down">
          {error}
        </p>
      )}
      <p role="status" className="mt-4 text-xs text-mute">
        {voted ? `Thanks. ${poll.total.toLocaleString("en-US")} votes so far.` : "One vote per visitor, no sign-in."} Closes {closesOn(poll.closesAt)}.
      </p>
    </section>
  );
}
