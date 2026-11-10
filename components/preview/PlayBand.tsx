import { ArrowRight, CalendarCheck, Swords, Target } from "lucide-react";
import { faceoffPairs, quizSet } from "@/lib/preview/data";

/**
 * Home: the two games, big and explained. Each has a <video> slot for a
 * short hover clip later; until then the screenshot is its poster.
 */
export function PlayBand() {
  const [a, b] = faceoffPairs(2)[1];
  const today = new Date().toISOString().slice(0, 10);
  const q = quizSet(`daily-${today}`)[0];
  const modes = [
    {
      href: "/play",
      Icon: Swords,
      motion: "icon-shake",
      title: "Face-off",
      line: "Two portfolios side by side. Pick the one you'd hire from, then see how everyone else voted.",
      steps: ["Look closer or visit both", "Pick one", "See the crowd's split"],
      media: (
        <span className="grid grid-cols-2 gap-px bg-edge">
          {[a, b].map((e) => (
            <video key={e.url} poster={`${e.shot}/hero.jpg`} muted playsInline loop preload="none" aria-hidden className="aspect-[16/10] w-full bg-raised object-cover object-top transition duration-500 group-hover:scale-[1.03]" />
          ))}
        </span>
      ),
      badge: null as React.ReactNode,
    },
    {
      href: "/play?mode=guess",
      Icon: Target,
      motion: "icon-twinkle",
      title: "Guess the percentile",
      line: "Five portfolios, the same for everyone today. Guess where each lands among every graded portfolio.",
      steps: ["See a portfolio", "Guess its top %", "Compare and share"],
      media: <video poster={`${q.shot}/hero.jpg`} muted playsInline loop preload="none" aria-hidden className="aspect-[32/10] w-full bg-raised object-cover object-top transition duration-500 group-hover:scale-[1.03]" />,
      badge: (
        <>
          <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/65 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur">
            <CalendarCheck className="h-3.5 w-3.5" aria-hidden /> Today&apos;s Daily 5
          </span>
          <span className="absolute bottom-3 right-3 rounded-lg bg-black/65 px-3 py-1.5 text-lg font-bold text-white backdrop-blur">Top ?%</span>
        </>
      ),
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
      {modes.map((m) => (
        <a key={m.title} href={m.href} className="card card-hover card-featured group flex flex-col overflow-hidden">
          <span className="relative block overflow-hidden">
            {m.media}
            {m.badge}
          </span>
          <span className="flex flex-1 flex-col p-5 sm:p-6">
            <span className="flex items-center gap-3">
              <span className="icon-tile h-12 w-12 shrink-0">
                <m.Icon className={`${m.motion} h-6 w-6`} aria-hidden />
              </span>
              <span className="text-xl font-bold tracking-tight">{m.title}</span>
            </span>
            <span className="mt-3 block text-[15px] text-mute text-pretty">{m.line}</span>
            <span className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-mute">
              {m.steps.map((s, k) => (
                <span key={s} className="flex items-center gap-2">
                  <span className="grid h-5 w-5 place-items-center rounded-full bg-raised text-[11px] font-bold text-ink ring-1 ring-edge">{k + 1}</span>
                  {s}
                </span>
              ))}
            </span>
            <span className="btn-sheen sheen-auto mt-5 inline-flex h-11 w-fit items-center gap-2 rounded-lg px-5 text-sm font-semibold">
              Play {m.title} <ArrowRight className="nudge h-4 w-4" aria-hidden />
            </span>
          </span>
        </a>
      ))}
    </div>
  );
}
