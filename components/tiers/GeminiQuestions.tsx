import { Bot } from "lucide-react";
import { PAGE_TEXT_MAX, ROLES_MAX } from "@/pipeline/rubric.mjs";

// The three things Gemini is asked about a site (rubric v3, owner 2026-11-22),
// for both grading pages (app/grading/page.tsx with RANKING_V2 off,
// components/tiers/EloGrading.tsx with it on). Nothing else is asked, and no
// answer is in the rank or the tier.

const QUESTIONS = [
  { q: "Is it a portfolio?", a: "Yes or no, with a short reason. A portfolio shows technical projects the person made; design work counts." },
  { q: "Five-second test", a: "Can a visitor tell who you are and what you do at a glance? 1 to 5, with a note." },
  { q: "Your roles", a: `Up to ${ROLES_MAX}, copied from what the page says about you.` },
];

export function GeminiQuestions() {
  return (
    <>
      <h3 className="flex items-center gap-2 font-bold">
        <Bot className="h-4 w-4 text-mute" aria-hidden /> Gemini: three questions, never in the rank
      </h3>
      <p className="mt-1 text-sm text-mute">
        One look at a screenshot of the top of the page and up to {PAGE_TEXT_MAX.toLocaleString("en-US")} characters of its text. Nothing else is asked.
      </p>
      <ol className="mt-4 grid gap-2.5 text-sm">
        {QUESTIONS.map((x, i) => (
          <li key={x.q} className="flex gap-3">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-edge text-xs font-bold tabular-nums" aria-hidden>
              {i + 1}
            </span>
            <span className="min-w-0">
              <span className="block font-medium">{x.q}</span>
              <span className="block text-mute">{x.a}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-sm text-mute">A &ldquo;not a portfolio&rdquo; answer can take a site off the list, with a record the owner can undo.</p>
    </>
  );
}
