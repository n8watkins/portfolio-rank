import {
  Bot,
  CalendarClock,
  Eye,
  FileText,
  FolderGit2,
  Globe,
  Layers,
  Link2,
  Mail,
  Megaphone,
  Merge,
  Palette,
  PenLine,
  Ruler,
  Sparkles,
  Users,
} from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { visitor } from "@/lib/preview/visitor";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "About PortfolioRank",
  description: "A project by n8builds: 2,103 community-listed developer portfolios, graded by code and Gemini and ranked by people.",
};

// Rubric v2 (GRADING_CRITERIA.md section 6, pipeline/rubric.mjs).
const CODE = [
  { id: "resume", Icon: FileText, name: "Resume link", weight: 10, what: "A link to a resume or CV." },
  { id: "github", Icon: FolderGit2, name: "GitHub link", weight: 10, what: "A link to a GitHub profile." },
  { id: "contact", Icon: Mail, name: "Contact path", weight: 20, what: "An email link, a contact form or a social profile." },
  { id: "links", Icon: Link2, name: "Project links load", weight: 25, what: "Up to 8 project and demo links answer; none is broken." },
  { id: "domain", Icon: Globe, name: "Own domain", weight: 10, what: "Your own domain, not a free hosting subdomain." },
  { id: "footer", Icon: CalendarClock, name: "Fresh footer year", weight: 10, what: "The copyright year is at most 2 years old." },
  { id: "original", Icon: Layers, name: "Not a known template", weight: 15, what: "No fingerprint of a popular template." },
];

const AI = [
  { id: "design", Icon: Palette, name: "Visual design", weight: 30, what: "Hierarchy, type, colour and space." },
  { id: "five-second", Icon: Eye, name: "Five-second test", weight: 20, what: "Who you are and what you do, at a glance." },
  { id: "story", Icon: Megaphone, name: "Project presentation", weight: 25, what: "Problem, your role, the outcome and links." },
  { id: "writing", Icon: PenLine, name: "Writing", weight: 15, what: "Clear, concise, in your own voice." },
  { id: "memorable", Icon: Sparkles, name: "Memorability", weight: 10, what: "Would a recruiter remember it tomorrow?" },
];

export default async function AboutPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const v = await visitor(await searchParams);
  return (
    <AppShell visitor={v} current="other">
      <div className="py-10 sm:py-14">
        <header className="rise grid grid-cols-1 items-end gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">About</p>
            <h1 className="mt-1.5 text-3xl font-bold tracking-tight text-balance sm:text-5xl">PortfolioRank, a project by n8builds</h1>
            <p className="mt-4 max-w-2xl text-[15px] text-mute text-pretty sm:text-lg">
              A free way to see how a developer portfolio holds up: a grade in a minute, a rank among {(2103).toLocaleString()} others, and the three things to fix
              first. Built and run by Nathan Watkins.
            </p>
          </div>
          <a href="https://n8builds.dev" target="_blank" rel="noopener" className="card card-hover flex items-center gap-4 p-5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/n8-icon.png" alt="" className="h-12 w-12 rounded-xl" />
            <span>
              <span className="block font-semibold">n8builds.dev</span>
              <span className="block text-sm text-mute">Apps, AI tools and Chrome extensions by the same builder.</span>
            </span>
          </a>
        </header>

        <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-3">
          {[
            {
              Icon: Users,
              t: "Where the list comes from",
              d: "The open developer-portfolios list on GitHub, curated by Emma Bostian and 1,700+ contributors. Anyone can add their site there or ask us to remove it.",
            },
            {
              Icon: Ruler,
              t: "What we check",
              d: "Code checks the facts every time: links, domain, resume, contact, footer year, template. Gemini judges design and writing from a screenshot and the page text.",
            },
            {
              Icon: Merge,
              t: "How the ranking works",
              d: "People vote in face-offs. Their votes and the AI grade make the merged rank. Near-equal sites show as a likely range, not a fake exact place.",
            },
          ].map(({ Icon, t, d }, k) => (
            <article key={t} className="card reveal p-6" style={{ "--d": `${k * 80}ms` } as React.CSSProperties}>
              <span className="icon-tile h-10 w-10">
                <Icon className="h-5 w-5" aria-hidden />
              </span>
              <h2 className="mt-4 text-lg font-bold tracking-tight">{t}</h2>
              <p className="mt-1.5 text-sm text-mute text-pretty">{d}</p>
            </article>
          ))}
        </div>

        <h2 id="grading" className="mt-16 scroll-mt-24 text-2xl font-bold tracking-tight sm:text-3xl">
          How grading works
        </h2>
        <p className="mt-2 max-w-2xl text-mute">Rubric v2. Code checks the facts; Gemini judges quality. A grade describes the page, not the developer.</p>

        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Group
            Icon={Ruler}
            title="Checked by code"
            line="Pass or fail. Free, and the same answer every time."
            items={CODE.map((c) => ({ ...c, scale: "pass / fail" }))}
            d={60}
          />
          <Group
            Icon={Bot}
            title="Judged by Gemini"
            line="Scored 1 to 5, with a one-line note each."
            items={AI.map((c) => ({ ...c, scale: "1-5" }))}
            d={120}
          />
        </div>

        <section aria-labelledby="ranking" className="card reveal mt-5 p-6 sm:p-7">
          <h2 id="ranking" className="text-lg font-bold tracking-tight">
            From grades to rank
          </h2>
          <ul className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            {[
              { Icon: Bot, t: "AI", d: "The Gemini scores and the code checks, weighted as above." },
              { Icon: Users, t: "People", d: "Face-off votes, as an ELO rating. Every vote moves two sites." },
              { Icon: Merge, t: "Merged", d: "Both together. Near-equal sites show as a likely range." },
            ].map(({ Icon, t, d }) => (
              <li key={t} className="flex gap-3">
                <span className="icon-tile h-9 w-9 shrink-0">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span>
                  <span className="block font-semibold">{t}</span>
                  <span className="block text-sm text-mute">{d}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-5 border-t border-edge pt-4 text-sm text-mute">
            Gemini sees the top of your page and up to 4,000 characters of its text, and nothing else. It runs on Google&apos;s free tier, so keep private details off
            the page you grade.
          </p>
        </section>
      </div>
    </AppShell>
  );
}

function Group({
  Icon,
  title,
  line,
  items,
  d,
}: {
  Icon: typeof Bot;
  title: string;
  line: string;
  items: { id: string; Icon: typeof Bot; name: string; weight: number; what: string; scale: string }[];
  d: number;
}) {
  return (
    <section aria-label={title} className="card rise flex flex-col p-6 sm:p-7" style={{ "--d": `${d}ms` } as React.CSSProperties}>
      <h2 className="flex items-center gap-2.5 text-lg font-bold tracking-tight">
        <span className="icon-tile h-9 w-9">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        {title}
      </h2>
      <p className="mt-2 text-sm text-mute">{line}</p>
      <ul className="mt-4 divide-y divide-edge">
        {items.map((c) => (
          <li key={c.id} id={c.id} className="flex scroll-mt-24 items-start gap-3 py-3">
            <c.Icon className="mt-0.5 h-4 w-4 shrink-0 text-mute" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{c.name}</span>
              <span className="block text-sm text-mute">{c.what}</span>
            </span>
            <span className="shrink-0 text-right text-xs tabular-nums text-mute">
              <span className="block font-semibold text-ink">{c.weight}%</span>
              {c.scale}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
