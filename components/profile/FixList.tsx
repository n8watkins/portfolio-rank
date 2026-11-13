import { CircleCheck, CircleX, Clock, Gauge, ListChecks, Share2 } from "lucide-react";
import type { Profile } from "@/lib/profile";
import { checklistItems } from "@/lib/tools/checklist";
import { ShareResultView } from "@/components/tools/ShareResult";
import { SpeedResult } from "@/components/tools/SpeedResult";

// The profile's fix list: every failed check, explained where it shows,
// with a preview of how it looks now (the share card as LinkedIn draws it,
// the Lighthouse scores), built from the saved results (lib/tools). A
// re-check saves over them, so a fixed item simply leaves the list.

/** Lighthouse categories worth fixing on mobile: performance under 50, the others under 90. */
const WEAK: Record<string, number> = { performance: 50, accessibility: 90, "best-practices": 90, seo: 90 };

const when = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function Group({ icon: Icon, title, at, children }: { icon: typeof Gauge; title: string; at?: number; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-edge bg-card p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-semibold">
          <Icon className="h-4 w-4 text-accent" aria-hidden /> {title}
        </h3>
        {at && (
          <span className="inline-flex items-center gap-1 text-xs text-mute">
            <Clock className="h-3 w-3" aria-hidden /> Checked {when(at)}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

export function FixList({ p }: { p: Profile }) {
  const { quick, share, mobile, desktop } = p.saved;
  const items = quick?.ok ? checklistItems(quick) : [];
  const failed = items.filter((i) => i.pass === false);
  const passed = items.filter((i) => i.pass === true);
  const shareFixes = share?.ok ? (share.issues ?? []).filter((i) => i.level === "fix") : [];
  const weak = mobile?.ok ? Object.entries(WEAK).filter(([id, line]) => typeof mobile.scores?.[id] === "number" && mobile.scores[id]! < line) : [];
  const nothingSaved = !quick && !share && !mobile;
  const nothingToFix = !nothingSaved && failed.length === 0 && shareFixes.length === 0 && weak.length === 0;

  if (nothingSaved) {
    return <p className="text-sm text-mute">No checks saved for this site yet. They run when the site is added or re-checked.</p>;
  }
  return (
    <div className="space-y-4">
      {nothingToFix && (
        <p className="flex items-center gap-2 rounded-xl border border-edge bg-card p-4 text-sm">
          <CircleCheck className="h-4 w-4 shrink-0 text-up" aria-hidden /> Nothing to fix from the checks. Nice work.
        </p>
      )}
      {failed.length > 0 && (
        <Group icon={ListChecks} title={`The basics: ${failed.length} to fix`} at={quick?.at}>
          <ul className="space-y-3">
            {failed.map((i) => (
              <li key={i.id} className="flex gap-3">
                <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-down" aria-hidden />
                <div className="min-w-0">
                  <p className="font-medium">
                    {i.label} <span className="font-normal text-mute">· {i.found}</span>
                  </p>
                  <p className="mt-0.5 text-sm text-mute">{i.tip}</p>
                </div>
              </li>
            ))}
          </ul>
        </Group>
      )}
      {shareFixes.length > 0 && share && (
        <Group icon={Share2} title="Your link preview" at={share.at}>
          <ShareResultView answer={{ url: p.url, listed: Boolean(p.listed), share, discovery: null }} />
        </Group>
      )}
      {weak.length > 0 && mobile && (
        <Group icon={Gauge} title="Speed and Lighthouse" at={mobile.at}>
          <SpeedResult answer={{ url: p.url, listed: Boolean(p.listed), mobile, desktop: desktop ?? { ok: false, error: "not_measured" }, discovery: null }} />
        </Group>
      )}
      {passed.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-mute">
          <CircleCheck className="h-4 w-4 text-up" aria-hidden /> Passed: {passed.map((i) => i.label.toLowerCase()).join(", ")}
          {share?.ok && shareFixes.length === 0 && ", link preview"}
          {mobile?.ok && weak.length === 0 && `, Lighthouse (${mobile.scores?.performance ?? "-"} on mobile)`}.
        </p>
      )}
    </div>
  );
}
