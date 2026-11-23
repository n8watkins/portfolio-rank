import { opinionWords, type ReportCard } from "@/lib/profile";
import { FIVE_SECOND_SCALE, PAGE_TEXT_MAX } from "@/pipeline/rubric.mjs";
import { AskedButton } from "./AskedButton";

// The Gemini report card on a profile (owner, 2026-11-22 and 2026-11-23): one
// model's opinion from one look, which never moves the rank or the tier. The
// card shows only the five-second test, with what each score from 1 to 5
// means (the same words the prompt gives the model, pipeline/rubric.mjs
// FIVE_SECOND_SCALE) and this site's score marked. Whether it is a portfolio
// and the roles are still asked and stored, but not shown here: the one
// exception is a site Gemini called not a portfolio that is still listed.
// What the model was shown and asked opens in the site's modal.

const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : null;

export function GeminiOpinion({ r, title = "Gemini report card" }: { r: ReportCard; title?: string }) {
  const five = r.axes.find((a) => a.key === "five_second_test") ?? null;
  const answered = date(r.judgedAt);
  const words = opinionWords(r);
  return (
    <section aria-labelledby="report-card" className="mt-4 rounded-xl border border-edge bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="report-card" className="font-semibold">
          {title}
        </h2>
        <AskedButton>
          <p>
            We showed Google&apos;s Gemini{r.model ? ` (${r.model})` : ""} one screenshot of the top of the home page, up to {PAGE_TEXT_MAX.toLocaleString("en-US")} characters of its
            text (emails and phone numbers removed) and the facts our code measured. {words.asked}
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Is this a portfolio, and why?</li>
            <li>The five-second test: can a visitor tell who you are and what you do, from 1 to 5?</li>
            <li>Which roles does the page name for you?</li>
          </ul>
          <p>Only the five-second test is shown on this page. None of the answers changes the rank or the tier.</p>
          {answered && <p>Answered on {answered}.</p>}
          <p>
            <a href="/grading" className="font-semibold text-accent underline underline-offset-2">
              How ranking and grading work
            </a>
          </p>
        </AskedButton>
      </div>
      <p className="text-xs text-mute">One model&apos;s opinion from one look. It does not change the rank or the tier.</p>

      {words.listing && (
        <p className="mt-3 rounded-lg border border-edge px-3 py-2 text-sm">
          <span className="font-semibold">Gemini said this may not be a portfolio.</span>
          {r.reason ? <span className="text-mute"> {r.reason}</span> : null}
          <span className="block text-xs text-mute">{words.listing}</span>
        </p>
      )}

      <div className="mt-3">
        <p className="text-sm font-medium">Five-second test: can a visitor tell who you are and what you do?</p>
        {five ? (
          <>
            <p className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-bold tabular-nums">{five.score}/5</span>
              {five.note && <span className="text-sm text-mute">{five.note}</span>}
            </p>
            <ol className="mt-2 grid gap-1 text-xs" aria-label="What each score means">
              {FIVE_SECOND_SCALE.map(({ score, means }) => {
                const mine = score === five.score;
                return (
                  <li
                    key={score}
                    aria-current={mine ? "true" : undefined}
                    className={`flex gap-2 rounded-md px-2 py-1 ${mine ? "bg-accent/10 font-semibold text-ink ring-1 ring-inset ring-accent/40" : "text-mute"}`}
                  >
                    <span className="w-4 shrink-0 tabular-nums">{score}</span>
                    <span>
                      {means}
                      {mine && <span className="sr-only"> (this site)</span>}
                    </span>
                  </li>
                );
              })}
            </ol>
          </>
        ) : (
          <p className="mt-1 text-sm text-mute">No answer.</p>
        )}
      </div>
    </section>
  );
}
