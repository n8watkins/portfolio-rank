"use client";

import { useState } from "react";
import { Pause, Play } from "lucide-react";

// MOCK (owner, 2026-11-13): "See the whole page", the site's full-page
// desktop capture scrolling slowly inside a laptop frame, beside a phone frame
// scrolling the phone capture. Pure CSS: hover a frame or press Play; with
// reduced motion there is no movement and each screen scrolls by hand.
// Shows nothing when the grade has no full-page captures (the capture
// pipeline doesn't make them yet).

const CSS = `
.wp-screen{position:relative;overflow:hidden}
.wp-screen img{display:block;width:100%;height:auto;transform:translateY(0)}
.wp-run .wp-screen img,.wp-screen:hover img{animation:wp-scroll var(--wp-time,26s) linear 0.6s infinite alternate}
@keyframes wp-scroll{to{transform:translateY(calc(-100% + var(--wp-h)))}}
@media (prefers-reduced-motion: reduce){
  .wp-screen{overflow-y:auto}
  .wp-run .wp-screen img,.wp-screen:hover img{animation:none}
}
`;

export function WholePage({ desktop, phone, domain }: { desktop: string; phone: string; domain: string }) {
  const [ok, setOk] = useState({ desktop: true, phone: true });
  const [run, setRun] = useState(false);
  if (!ok.desktop && !ok.phone) return null;
  return (
    <section aria-labelledby="whole" className="mt-12 print:hidden">
      <style>{CSS}</style>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-edge pb-2">
        <div>
          <h2 id="whole" className="text-lg font-bold tracking-tight">
            See the whole page
          </h2>
          <p className="text-sm text-mute">What we captured of {domain}, top to bottom. Hover a screen, or press play.</p>
        </div>
        <button type="button" onClick={() => setRun((r) => !r)} aria-pressed={run} className="inline-flex h-10 items-center gap-2 rounded-lg border border-edge px-3.5 text-sm font-semibold hover:bg-raised">
          {run ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} {run ? "Pause" : "Play"}
        </button>
      </div>
      <div className={`mt-6 flex flex-wrap items-end justify-center gap-8 ${run ? "wp-run" : ""}`}>
        {ok.desktop && (
          // A laptop: the screen in a dark bezel on a thin base.
          <figure className="w-full max-w-[40rem]">
            <div className="rounded-t-2xl bg-[#1b1c20] p-3 pb-4 shadow-[0_18px_40px_-20px_rgba(0,0,0,0.5)]">
              <div className="wp-screen rounded-md bg-raised" style={{ "--wp-h": "22rem", height: "22rem" } as React.CSSProperties}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={desktop} alt={`The whole page of ${domain} on a desktop`} loading="lazy" onError={() => setOk((o) => ({ ...o, desktop: false }))} />
              </div>
            </div>
            <div className="mx-auto h-3 w-[108%] -translate-x-[3.7%] rounded-b-xl bg-gradient-to-b from-[#cfd2d8] to-[#9da2ab]" aria-hidden />
            <figcaption className="mt-2 text-center text-xs text-mute">Desktop, 1440 px wide</figcaption>
          </figure>
        )}
        {ok.phone && (
          // A phone: rounded body, a notch, the screen inside.
          <figure className="w-[11.5rem]">
            <div className="rounded-[2rem] bg-[#1b1c20] p-2.5 shadow-[0_18px_40px_-20px_rgba(0,0,0,0.5)]">
              <div className="wp-screen rounded-[1.5rem] bg-raised" style={{ "--wp-h": "24rem", "--wp-time": "22s", height: "24rem" } as React.CSSProperties}>
                <span className="absolute top-1.5 left-1/2 z-10 h-4 w-16 -translate-x-1/2 rounded-full bg-[#1b1c20]" aria-hidden />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={phone} alt={`The whole page of ${domain} on a phone`} loading="lazy" onError={() => setOk((o) => ({ ...o, phone: false }))} />
              </div>
            </div>
            <figcaption className="mt-2 text-center text-xs text-mute">Phone, 390 px wide</figcaption>
          </figure>
        )}
      </div>
    </section>
  );
}
