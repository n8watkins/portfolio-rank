import { ArrowRight, CalendarCheck, Swords, Target } from "lucide-react";
import { faceoffPairs, quizSet } from "@/lib/preview/data";

/** Home: the two games, big and inviting, with real screenshots. */
export function PlayBand() {
  const [a, b] = faceoffPairs(2)[1];
  const today = new Date().toISOString().slice(0, 10);
  const q = quizSet(`daily-${today}`)[0];
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
      <a href="/play" className="card card-hover card-featured group flex flex-col overflow-hidden">
        <span className="grid grid-cols-2 gap-px bg-edge">
          {[a, b].map((e) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={e.url} src={`${e.shot}/hero.jpg`} alt="" loading="lazy" className="aspect-[16/10] w-full bg-raised object-cover object-top transition duration-500 group-hover:scale-[1.03]" />
          ))}
        </span>
        <span className="flex items-center gap-4 p-5">
          <span className="icon-tile h-12 w-12 shrink-0">
            <Swords className="icon-shake h-6 w-6" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-lg font-bold">Face-off</span>
            <span className="block text-sm text-mute">Two portfolios. Pick the one you&apos;d hire from, then see how everyone voted.</span>
          </span>
          <ArrowRight className="nudge h-5 w-5 shrink-0 text-accent" aria-hidden />
        </span>
      </a>
      <a href="/play?mode=guess" className="card card-hover card-featured group flex flex-col overflow-hidden">
        <span className="relative block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${q.shot}/hero.jpg`} alt="" loading="lazy" className="aspect-[32/10] w-full bg-raised object-cover object-top transition duration-500 group-hover:scale-[1.03]" />
          <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur">
            <CalendarCheck className="h-3.5 w-3.5" aria-hidden /> Today&apos;s Daily 5
          </span>
          <span className="absolute bottom-3 right-3 rounded-lg bg-black/60 px-2.5 py-1 text-sm font-bold text-white backdrop-blur">Top ?%</span>
        </span>
        <span className="flex items-center gap-4 p-5">
          <span className="icon-tile h-12 w-12 shrink-0">
            <Target className="icon-twinkle h-6 w-6" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-lg font-bold">Guess the percentile</span>
            <span className="block text-sm text-mute">Five portfolios, same for everyone today. How close can you get?</span>
          </span>
          <ArrowRight className="nudge h-5 w-5 shrink-0 text-accent" aria-hidden />
        </span>
      </a>
    </div>
  );
}
