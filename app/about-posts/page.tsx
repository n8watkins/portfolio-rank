import type { Metadata } from "next";
import { BarChart3, Bot, Image as ImageIcon, PenLine, Search, ShieldCheck, UserCheck } from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { ROUTES } from "@/lib/nav";

// How the blog's posts are written (docs/legal/ai-content.md), linked from
// the AI line on every post. In Nathan's voice: plain, first person.

export const metadata: Metadata = {
  title: "How posts are made - PortfolioRank",
  description: "PortfolioRank's posts are written with AI from its own data. Code computes every number, checks run before anything goes out, and I read every post first.",
  alternates: { canonical: "/about-posts" },
};

const d = (ms: number) => ({ "--d": `${ms}ms` }) as React.CSSProperties;

const STEPS = [
  { Icon: Search, title: "Find", body: "Each week the pipeline collects story ideas from the leaderboard, the grades and the experiments." },
  { Icon: BarChart3, title: "Facts", body: "Code computes every number and draws every chart. The AI never makes up a figure." },
  { Icon: PenLine, title: "Write", body: "Gemini writes the post around those facts, in a fixed template." },
  { Icon: ShieldCheck, title: "Check", body: "Automatic checks run on every draft. A draft that still fails after two rewrites is dropped." },
  { Icon: UserCheck, title: "Review", body: "I read every draft that passes and publish it or throw it out. Nothing goes out without that." },
];

const CHECKS = [
  "Every number in the text must match the computed data exactly.",
  "Every link must load. Quotes and sources can't be invented: an outside claim stays only if a web search backs it, and its source is listed under the post.",
  "A second AI pass reviews the topic, the tone and every claim.",
  "Naming rule: a developer is named only for a good reason, like a top site or a big climb. Low scores and anything critical are discussed only in aggregate.",
];

export default function AboutPostsPage() {
  return (
    <div className="pb-20">
      <section aria-labelledby="about-posts" className="band band-glow">
        <div className="mx-auto max-w-3xl px-4 py-12 text-center sm:px-6 sm:py-16">
          <p className="rise text-xs font-semibold uppercase tracking-[0.14em] text-accent">Blog</p>
          <h1 id="about-posts" className="rise mt-2 text-4xl font-bold tracking-tight text-balance sm:text-5xl" style={d(40)}>
            How posts are made
          </h1>
          <p className="rise mx-auto mt-4 max-w-xl text-[15px] text-mute text-pretty sm:text-lg" style={d(80)}>
            The posts are written with AI (Google&apos;s Gemini) from PortfolioRank&apos;s own data. I set the rules and the checks, and I read every post before it goes out.
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <section aria-labelledby="steps" className="mt-12">
          <SectionHeader id="steps" eyebrow="The pipeline" title="From data to post" className="mb-5" />
          <ol className="grid gap-3">
            {STEPS.map(({ Icon, title, body }, i) => (
              <li key={title} className="card flex items-start gap-4 p-4 sm:p-5">
                <span className="icon-tile h-10 w-10 shrink-0">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold">
                    <span className="mr-1.5 tabular-nums text-mute">{i + 1}.</span>
                    {title}
                  </span>
                  <span className="mt-0.5 block text-[15px] text-mute">{body}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="checks" className="mt-14">
          <SectionHeader id="checks" eyebrow="Before anything goes out" title="The checks" className="mb-5" />
          <ul className="grid gap-3 text-[15px] leading-relaxed">
            {CHECKS.map((c) => (
              <li key={c} className="flex gap-3">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-up" aria-hidden />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="images" className="mt-14">
          <SectionHeader id="images" eyebrow="Pictures" title="Where the images come from" className="mb-5" />
          <ul className="grid gap-3 text-[15px] leading-relaxed">
            <li className="flex gap-3">
              <BarChart3 className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
              <span>Charts are drawn by code from the same data as the text, so a chart can&apos;t disagree with it.</span>
            </li>
            <li className="flex gap-3">
              <ImageIcon className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
              <span>Screenshots are our own captures of listed portfolios, and follow the naming rule. Stock photos come from Pexels and credit the photographer.</span>
            </li>
            <li className="flex gap-3">
              <Bot className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
              <span>Illustrations are made with AI (Cloudflare Workers AI), checked, and captioned &ldquo;AI-generated illustration&rdquo;.</span>
            </li>
          </ul>
        </section>

        <section aria-labelledby="mistakes" className="mt-14">
          <SectionHeader id="mistakes" eyebrow="Corrections" title="If something is wrong" className="mb-5" />
          <div className="grid gap-3 text-[15px] leading-relaxed text-mute">
            <p>
              Every post says when its data is from, so you can tell when the numbers were true. If you spot a mistake, email{" "}
              <a href="mailto:nate@n8builds.dev" className="font-medium text-ink underline decoration-edge-strong underline-offset-2 hover:decoration-accent">
                nate@n8builds.dev
              </a>{" "}
              or open an issue on{" "}
              <a href="https://github.com/n8watkins/portfolio-rank/issues" className="font-medium text-ink underline decoration-edge-strong underline-offset-2 hover:decoration-accent">
                GitHub
              </a>
              . I fix or unpublish it within 14 days.
            </p>
            <p>
              Grades and rankings are opinions, from people&apos;s votes and an AI judge, measured against{" "}
              <a href={ROUTES.grading ?? "/grading"} className="font-medium text-ink underline decoration-edge-strong underline-offset-2 hover:decoration-accent">
                published criteria
              </a>
              . They are not judgments of the developers. Every site on the list shipped, which is more than most.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
