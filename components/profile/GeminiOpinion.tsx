import { Check, X } from "lucide-react";
import { opinionWords, type ReportCard } from "@/lib/profile";
import { PAGE_TEXT_MAX } from "@/pipeline/rubric.mjs";

// The Gemini report card on a profile (owner, 2026-11-22): a separate,
// optional opinion that says plainly what the model was asked. The rank and
// the tier come only from code measurements and votes; this card never moves
// them. Only the three kept outputs are shown, for an older grade too
// (lib/profile.ts reportCard): whether it is a portfolio, the five-second
// test and the roles.

const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : null;

function Row({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-edge p-3">
      <p className="text-sm font-medium">{q}</p>
      <div className="mt-1.5 text-sm">{children}</div>
    </div>
  );
}

export function GeminiOpinion({ r, title = "Gemini report card" }: { r: ReportCard; title?: string }) {
  const five = r.axes.find((a) => a.key === "five_second_test") ?? null;
  const answered = date(r.judgedAt);
  const words = opinionWords(r);
  return (
    <section aria-labelledby="report-card" className="mt-4 rounded-xl border border-edge bg-card p-5">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-edge text-lg font-bold text-ink" aria-hidden>
          AI
        </span>
        <div className="min-w-0">
          <h2 id="report-card" className="font-semibold">
            {title}
          </h2>
          <p className="text-xs text-mute">An opinion from one look. It does not change the rank or the tier.</p>
        </div>
      </div>

      <div className="mt-4 rounded-lg bg-raised p-3 text-sm text-mute">
        <p className="font-semibold text-ink">What we asked the model</p>
        <p className="mt-1">
          We showed Google&apos;s Gemini{r.model ? ` (${r.model})` : ""} one screenshot of the top of the home page, up to {PAGE_TEXT_MAX.toLocaleString("en-US")} characters of
          its text (emails and phone numbers removed) and the facts our code measured. {words.asked}
        </p>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2">
        <Row q="Is this a portfolio?">
          <p className="flex items-start gap-1.5">
            {r.aiIsPortfolio ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-up" aria-hidden /> : <X className="mt-0.5 h-4 w-4 shrink-0 text-down" aria-hidden />}
            <span>
              <span className="font-semibold">{r.aiIsPortfolio ? "Yes" : "No"}</span>
              {r.reason ? <span className="text-mute"> - {r.reason}</span> : null}
              {words.listing ? <span className="block text-xs text-mute">{words.listing}</span> : null}
            </span>
          </p>
        </Row>
        <Row q="Five-second test: can a visitor tell who you are and what you do?">
          {five ? (
            <>
              <div className="flex items-center gap-3">
                <div className="h-1.5 flex-1 rounded-full bg-edge">
                  <div className="h-1.5 rounded-full bg-accent" style={{ width: `${(five.score / 5) * 100}%` }} />
                </div>
                <span className="font-bold tabular-nums">{five.score}/5</span>
              </div>
              {five.note && <p className="mt-1.5 text-xs text-mute">{five.note}</p>}
            </>
          ) : (
            <p className="text-mute">No answer.</p>
          )}
        </Row>
        <Row q="Which roles do you name for yourself?">
          {r.roles.length ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="Roles">
              {r.roles.map((role) => (
                <li key={role} className="rounded-full border border-edge px-2 py-0.5 text-xs">
                  {role}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-mute">None named on the page.</p>
          )}
        </Row>
      </div>

      <p className="mt-3 text-xs text-mute">
        {answered ? `Answered on ${answered}. ` : ""}
        <a href="/grading" className="underline decoration-edge-strong underline-offset-2 hover:text-ink">
          How ranking and grading work
        </a>
      </p>
    </section>
  );
}
