import { ArrowRight, Swords, Target } from "lucide-react";

/** Pulls people from a portfolio page into the games, starting with this site. */
export function PlayCta({ slug, name }: { slug: string; name: string }) {
  const seed = "p" + Math.abs([...slug].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)).toString(36).slice(0, 6);
  const cards = [
    {
      href: `/play?with=${encodeURIComponent(slug)}`,
      Icon: Swords,
      shake: "icon-shake",
      title: "Put it in a face-off",
      line: `${name} against another portfolio. Which would you hire from?`,
    },
    {
      href: `/play?mode=guess&quiz=${seed}&with=${encodeURIComponent(slug)}`,
      Icon: Target,
      shake: "icon-twinkle",
      title: "Guess its percentile",
      line: "Where does it land among every graded portfolio? Then four more.",
    },
  ];
  return (
    <section aria-labelledby="play-cta" className="band band-raised band-rule rise my-6 rounded-2xl px-4 py-6 sm:px-6">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Play</p>
      <h2 id="play-cta" className="mt-1 text-xl font-bold tracking-tight sm:text-2xl">
        Think you know where this one stands?
      </h2>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {cards.map(({ href, Icon, shake, title, line }) => (
          <a key={title} href={href} className="card card-hover group flex items-center gap-4 p-4 sm:p-5">
            <span className="icon-tile h-12 w-12 shrink-0">
              <Icon className={`${shake} h-6 w-6`} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-base font-bold">{title}</span>
              <span className="block text-sm text-mute">{line}</span>
            </span>
            <ArrowRight className="nudge h-5 w-5 shrink-0 text-accent" aria-hidden />
          </a>
        ))}
      </div>
    </section>
  );
}
