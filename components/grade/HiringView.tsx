import { ArrowRight, Check, FolderGit2, Mail, ShieldCheck, Wrench } from "lucide-react";
import type { GradePage } from "@/lib/grade-page";

type Groups = NonNullable<GradePage["report"]>["groups"];

const ICON = { reach: Mail, work: FolderGit2, current: ShieldCheck } as const;

/**
 * The measured facts as a hiring manager reads them (lib/grader/present.mjs
 * hiringGroups): three questions, what's covered as chips, and each missing
 * fact as a card with what it means, the fix and a link to why it counts.
 */
export function HiringView({ groups, whyHref }: { groups: Groups; whyHref: string | null }) {
  return (
    <div className="grid gap-4">
      {groups.map((g) => {
        const Icon = ICON[g.key as keyof typeof ICON] ?? ShieldCheck;
        return (
          <div key={g.key} className="rounded-xl border border-edge bg-bg/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Icon className="h-4 w-4 text-mute" aria-hidden /> {g.title}
              </h3>
              {g.missing.length === 0 ? (
                <span className="rounded-full bg-up/10 px-2 py-0.5 text-[11px] font-semibold text-up">Covered</span>
              ) : (
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">{g.missing.length} to fix</span>
              )}
            </div>
            {g.ok.length + g.unknown.length > 0 && (
              <ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label="What it has">
                {g.ok.map((f) => (
                  <li key={f.id} className="inline-flex items-center gap-1 rounded-full border border-up/30 px-2 py-0.5 text-xs" title={f.detail}>
                    <Check className="h-3 w-3 text-up" aria-hidden /> {f.short}
                  </li>
                ))}
                {g.unknown.map((f) => (
                  <li key={f.id} className="inline-flex items-center gap-1 rounded-full border border-dashed border-edge-strong px-2 py-0.5 text-xs text-mute">
                    {f.short}: not measured
                  </li>
                ))}
              </ul>
            )}
            {g.missing.map((f) => (
              <div key={f.id} className="mt-3 flex gap-3 rounded-lg border border-accent/25 bg-card p-3">
                <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
                <p className="min-w-0 text-sm">
                  <span className="block font-semibold">
                    {f.short}: <span className="font-normal text-mute">{f.detail}</span>
                  </span>
                  <span className="block text-mute">{f.missing}</span>
                  <span className="mt-1 block">
                    <span className="font-medium">Fix:</span> {f.fix}{" "}
                    {whyHref && (
                      <a href={whyHref} className="group inline-flex items-center gap-0.5 font-semibold text-accent print:hidden">
                        Why <ArrowRight className="nudge h-3 w-3" aria-hidden />
                        <span className="sr-only"> {f.short.toLowerCase()} counts</span>
                      </a>
                    )}
                  </span>
                </p>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
