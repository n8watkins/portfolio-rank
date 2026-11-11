import { ArrowRight, Check, Mail, ShieldCheck, Wrench, FolderGit2 } from "lucide-react";
import type { Scorecard } from "@/lib/preview/data";

type Fact = Scorecard["facts"][number];

// What each missing fact means to a hiring manager, and the fix.
const MEANING: Record<string, { short: string; missing: string; fix: string; criterion: string }> = {
  "Contact path": { short: "Contact", missing: "Someone who likes your work has no way to reach you.", fix: "Add an email link or a contact form.", criterion: "contact" },
  "Resume linked": { short: "Resume", missing: "Recruiters look for a resume first; many move on without one.", fix: "Link a PDF from the top of the page.", criterion: "resume" },
  "GitHub linked": { short: "GitHub", missing: "They can't check your code.", fix: "Link your GitHub profile beside your contact links.", criterion: "github" },
  "Project links work": { short: "Working project links", missing: "A dead demo reads as abandoned work.", fix: "Fix or remove the broken links.", criterion: "links" },
  "Own domain": { short: "Own domain", missing: "A shared host looks temporary.", fix: "A domain costs about $12 a year and reads as yours.", criterion: "domain" },
  "Fresh footer year": { short: "Up to date", missing: "An old year suggests the site was left behind.", fix: "Update the footer year, or drop it.", criterion: "footer" },
  "Not a known template": { short: "Your own design", missing: "It looks like many other portfolios.", fix: "Change the layout, type or colours so it feels like yours.", criterion: "original" },
};

const GROUPS = [
  { title: "Can they reach you?", Icon: Mail, facts: ["Contact path", "Resume linked"] },
  { title: "Can they see your work?", Icon: FolderGit2, facts: ["GitHub linked", "Project links work"] },
  { title: "Does it look current and yours?", Icon: ShieldCheck, facts: ["Own domain", "Fresh footer year", "Not a known template"] },
];

/** The measured facts as a hiring manager reads them: what's covered, what to fix. */
export function HiringView({ facts }: { facts: Fact[] }) {
  const by = new Map(facts.map((f) => [f.label, f]));
  return (
    <div className="grid gap-4">
      {GROUPS.map((g) => {
        const items = g.facts.map((l) => by.get(l)).filter(Boolean) as Fact[];
        const ok = items.filter((f) => f.pass);
        const missing = items.filter((f) => !f.pass);
        return (
          <div key={g.title} className="rounded-xl border border-edge bg-bg/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <g.Icon className="h-4 w-4 text-mute" aria-hidden /> {g.title}
              </h3>
              {missing.length === 0 ? (
                <span className="rounded-full bg-up/10 px-2 py-0.5 text-[11px] font-semibold text-up">Covered</span>
              ) : (
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">
                  {missing.length} to fix
                </span>
              )}
            </div>
            {ok.length > 0 && (
              <p className="mt-2.5 flex flex-wrap gap-1.5">
                {ok.map((f) => (
                  <span key={f.label} className="inline-flex items-center gap-1 rounded-full border border-up/30 px-2 py-0.5 text-xs" title={f.detail}>
                    <Check className="h-3 w-3 text-up" aria-hidden /> {MEANING[f.label]?.short ?? f.label}
                  </span>
                ))}
              </p>
            )}
            {missing.map((f) => {
              const m = MEANING[f.label];
              return (
                <div key={f.label} className="mt-3 flex gap-3 rounded-lg border border-accent/25 bg-card p-3">
                  <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
                  <p className="min-w-0 text-sm">
                    <span className="block font-semibold">
                      {m?.short ?? f.label}: <span className="font-normal text-mute">{f.detail}</span>
                    </span>
                    <span className="block text-mute">{m?.missing}</span>
                    <span className="mt-1 block">
                      <span className="font-medium">Fix:</span> {m?.fix}{" "}
                      <a href={`/about#${m?.criterion}`} className="group inline-flex items-center gap-0.5 font-semibold text-accent">
                        Why <ArrowRight className="nudge h-3 w-3" aria-hidden />
                      </a>
                    </span>
                  </p>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
