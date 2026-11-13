import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { toolsEnabled } from "@/lib/tools/server";
import { Glow, ToolsHero } from "@/components/tools/ToolsHero";

// The portfolio checklist on its own (docs/TOOLS.md): a search landing page
// and the place a report's failed checks point to.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Developer Portfolio Checklist: Resume, GitHub, Contact, Links and Domain - PortfolioRank",
  description:
    "Free developer portfolio checker: does your site link a resume and GitHub, give a way to contact you, have project links that load, its own domain, HTTPS and a current footer?",
  alternates: { canonical: "/tools/portfolio-checklist" },
};

const WHY: { name: string; body: string }[] = [
  { name: "Resume and GitHub", body: "The two links a recruiter looks for first. Put them in the header or the first screen." },
  { name: "A way to reach you", body: "An email link, a form or LinkedIn. A portfolio nobody can answer doesn't get you interviews." },
  { name: "Links that load", body: "A dead demo reads as an abandoned project. We check up to eight project and demo links." },
  { name: "Your own domain", body: "yourname.dev looks more serious than a free hosting address and stays yours if you move hosts." },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "It says \"couldn't tell\". Why?",
    a: "Some sites build the page with JavaScript after it loads, so the HTML we read is nearly empty. Make sure your links are in the page's HTML (server rendering or a static build), which also helps search engines.",
  },
  {
    q: "Is this the same as the grade?",
    a: "It's the part code can check. A grade adds an AI reading of your design, writing and projects, where you'd rank, and the three things to fix first.",
  },
  {
    q: "Which project links do you check?",
    a: "Up to eight links that look like projects or demos, each fetched once. A site that blocks robots counts as \"wouldn't let us check\", not broken.",
  },
];

export default async function ChecklistTool({ searchParams }: { searchParams: Promise<{ url?: string }> }) {
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
        kicker="Free portfolio checklist"
        title={
          <>
            Does your portfolio have the <Glow>basics</Glow>?
          </>
        }
        lead="Resume, GitHub, a way to contact you, project links that load, your own domain, HTTPS and a current footer, checked in seconds."
        tools={["checklist"]}
        initialUrl={initialUrl}
        cta="Check the basics"
      />

      <section aria-labelledby="checklist-why" className="wrap max-w-6xl pt-12">
        <h2 id="checklist-why" className="text-2xl font-bold tracking-tight sm:text-3xl">
          What hiring managers look for first
        </h2>
        <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {WHY.map((w) => (
            <li key={w.name} className="card p-5">
              <h3 className="font-semibold">{w.name}</h3>
              <p className="mt-1.5 text-sm text-mute">{w.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="checklist-faq" className="wrap max-w-6xl pt-14">
        <h2 id="checklist-faq" className="text-2xl font-bold tracking-tight sm:text-3xl">
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
