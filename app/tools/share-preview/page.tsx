import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { toolsEnabled } from "@/lib/tools/server";
import { Glow, ToolsHero } from "@/components/tools/ToolsHero";

// The share preview checker on its own (docs/TOOLS.md): a search landing
// page and the place a report's "your link preview has no image" points to.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Link Preview Checker: See Your Portfolio's Card on LinkedIn, X and Slack - PortfolioRank",
  description:
    "Free Open Graph checker for portfolios: see the card LinkedIn, X and Slack show for your link, check og:image, title and description, and get plain fixes.",
  alternates: { canonical: "/tools/share-preview" },
};

const TAGS: { tag: string; body: string }[] = [
  { tag: "og:image", body: "The picture on the card. 1200 x 630 pixels, under 1 MB, a full https:// address. The biggest single upgrade for most portfolios." },
  { tag: "og:title", body: "The card's headline. Your name and role, under about 60 characters. Falls back to the page's <title>." },
  { tag: "og:description", body: "One sentence under the title: what you build and what you're looking for. About 150 characters." },
  { tag: "twitter:card", body: "Set it to summary_large_image so X shows your image full width instead of a small square." },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "I fixed my tags but LinkedIn still shows the old card. Why?",
    a: "Apps cache link previews for days. LinkedIn's Post Inspector and X's card validator refresh it; Slack refreshes when the link is shared again later. Check again here to confirm your tags are right.",
  },
  {
    q: "Why does it matter for a portfolio?",
    a: "Recruiters and hiring managers usually meet your portfolio as a link in a message or a post. A card with your name, a clear line and a good image gets opened; a bare link often doesn't.",
  },
  {
    q: "Do I need a different image for each app?",
    a: "No. One 1200 x 630 image in og:image works for LinkedIn, X, Slack, Discord and most others.",
  },
];

export default async function SharePreviewTool({ searchParams }: { searchParams: Promise<{ url?: string }> }) {
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
        kicker="Free share preview checker"
        title={
          <>
            What does your <Glow>link</Glow> look like?
          </>
        }
        lead="See the card LinkedIn, X and Slack show when someone shares your portfolio, and fix the title, description and image in minutes."
        tools={["share"]}
        initialUrl={initialUrl}
        cta="Check my link"
      />

      <section aria-labelledby="share-tags" className="wrap max-w-6xl pt-12">
        <h2 id="share-tags" className="text-2xl font-bold tracking-tight sm:text-3xl">
          The four tags that make the card
        </h2>
        <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {TAGS.map((t) => (
            <li key={t.tag} className="card p-5">
              <h3 className="font-mono text-sm font-semibold">{t.tag}</h3>
              <p className="mt-1.5 text-sm text-mute">{t.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="share-faq" className="wrap max-w-6xl pt-14">
        <h2 id="share-faq" className="text-2xl font-bold tracking-tight sm:text-3xl">
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
