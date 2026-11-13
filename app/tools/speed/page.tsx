import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { toolsEnabled } from "@/lib/tools/server";
import { Glow, ToolsHero } from "@/components/tools/ToolsHero";

// The speed and Lighthouse check on its own (docs/TOOLS.md), for people who
// search for a website speed test; the hub runs it with the other tools.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Free Website Speed Test for Portfolios: Lighthouse on Mobile and Desktop - PortfolioRank",
  description:
    "Test your portfolio's speed for free with Google Lighthouse on mobile and desktop: performance, accessibility, best practices and SEO scores, Core Web Vitals in plain words, and what to fix first.",
  alternates: { canonical: "/tools/speed" },
};

const SCORES: { name: string; body: string }[] = [
  { name: "Performance", body: "How fast the page loads and responds, from the Core Web Vitals below. Most portfolios lose points on big images and heavy scripts." },
  { name: "Accessibility", body: "Whether everyone can use it: text contrast, labels on icon links, alt text, headings in order. Recruiters notice a site that's hard to read." },
  { name: "Best practices", body: "HTTPS, no errors in the console, images shown at their real shape. Small things that read as care." },
  { name: "SEO", body: "Whether search engines can find and describe the page: a title, a meta description, links that can be followed." },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Why is my mobile score lower than desktop?",
    a: "Lighthouse tests mobile on a mid-range phone over a slow 4G connection, on purpose. That's what many visitors have, and it's what Google ranks on. A score in the 70s on mobile is normal; desktop is usually higher.",
  },
  {
    q: "Why does the score change between runs?",
    a: "Network and server timing vary a little each time, so a few points up or down is normal. We keep a result for a day, so checking again within 24 hours shows the same numbers.",
  },
  {
    q: "What score should a portfolio aim for?",
    a: "90 or more is green on every scale. For a portfolio, aim for green on accessibility, best practices and SEO, which are mostly simple fixes, and 70 or more on mobile performance.",
  },
  {
    q: "Is it really free?",
    a: "Yes. It runs Google's PageSpeed Insights, which is free within a daily limit; when the day's checks are used up we say so instead of charging anyone. No account needed.",
  },
];

export default async function SpeedTool({ searchParams }: { searchParams: Promise<{ url?: string }> }) {
  if (!toolsEnabled()) notFound();
  const sp = await searchParams;
  const initialUrl = typeof sp.url === "string" ? sp.url.slice(0, 500) : "";
  return (
    <>
      <div className="wrap max-w-6xl pt-6">
        <a href="/tools" className="group inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-mute transition hover:text-ink">
          <ArrowLeft className="h-4 w-4 transition group-hover:-translate-x-0.5" aria-hidden /> All free tools
        </a>
      </div>
      <ToolsHero
        kicker="Free speed test"
        title={
          <>
            How fast is your <Glow>portfolio</Glow>?
          </>
        }
        lead="Google Lighthouse on a phone and a desktop: four scores, the Core Web Vitals in plain words, and the fixes that matter most. About a minute, no account."
        tools={["speed"]}
        initialUrl={initialUrl}
        cta="Test my speed"
      />

      <section aria-labelledby="speed-scores" className="wrap max-w-6xl pt-12">
        <h2 id="speed-scores" className="text-2xl font-bold tracking-tight sm:text-3xl">
          What the four scores mean
        </h2>
        <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {SCORES.map((s) => (
            <li key={s.name} className="card p-5">
              <h3 className="font-semibold">{s.name}</h3>
              <p className="mt-1.5 text-sm text-mute">{s.body}</p>
            </li>
          ))}
        </ul>
        <p className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-mute">
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-up" aria-hidden /> 90 to 100 good
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-accent" aria-hidden /> 50 to 89 needs work
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-down" aria-hidden /> 0 to 49 poor
          </span>
        </p>
      </section>

      <section aria-labelledby="speed-faq" className="wrap max-w-6xl pt-14">
        <h2 id="speed-faq" className="text-2xl font-bold tracking-tight sm:text-3xl">
          Questions
        </h2>
        <dl className="mt-6 grid grid-cols-1 gap-x-10 gap-y-6 md:grid-cols-2">
          {FAQ.map((f) => (
            <div key={f.q}>
              <dt className="font-semibold">{f.q}</dt>
              <dd className="mt-1.5 text-sm text-mute">{f.a}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}
