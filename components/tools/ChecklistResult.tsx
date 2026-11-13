import { CircleAlert, CircleCheck, CircleHelp, CircleX } from "lucide-react";
import type { ChecklistItem } from "@/lib/tools/checklist";

export type ChecklistAnswer = {
  url: string;
  listed: boolean;
  profile?: string;
  checklist: { ok: boolean; error?: string; message?: string; items?: ChecklistItem[]; measuredAt?: string };
  discovery: { status: string; added: boolean } | null;
};

/** The portfolio checklist's answer: what failed first, with its fix, then what passed. */
export function ChecklistResult({ answer }: { answer: ChecklistAnswer }) {
  const c = answer.checklist;
  if (!c.ok || !c.items) {
    return (
      <p className="flex items-start gap-2 rounded-xl border border-edge bg-raised/50 p-4 text-sm">
        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-mute" aria-hidden />
        {c.message ?? "We couldn't read this page. Try again in a few minutes."}
      </p>
    );
  }
  const rank = (i: ChecklistItem) => (i.pass === false ? 0 : i.pass === null ? 1 : 2);
  const items = [...c.items].sort((a, b) => rank(a) - rank(b));
  const passed = c.items.filter((i) => i.pass).length;
  return (
    <div>
      <p className="text-sm text-mute">
        <span className="text-2xl font-bold tabular-nums text-ink">
          {passed} of {c.items.length}
        </span>{" "}
        passed
      </p>
      {c.message && <p className="mt-2 text-xs text-mute">{c.message}</p>}
      <ul className="mt-4 grid gap-2 md:grid-cols-2">
        {items.map((i) => {
          const Icon = i.pass ? CircleCheck : i.pass === false ? CircleX : CircleHelp;
          return (
            <li key={i.id} className={`flex gap-3 rounded-xl border bg-card p-4 ${i.pass === false ? "border-down/40" : "border-edge"}`}>
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${i.pass ? "text-up" : i.pass === false ? "text-down" : "text-mute"}`} aria-hidden />
              <div className="min-w-0">
                <p className="font-medium">
                  {i.label}
                  <span className="sr-only">: {i.pass ? "passed" : i.pass === false ? "failed" : "couldn't tell"}</span>
                </p>
                <p className="mt-0.5 break-words text-sm text-mute">{i.found}</p>
                {i.pass !== true && <p className="mt-2 text-sm">{i.tip}</p>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
