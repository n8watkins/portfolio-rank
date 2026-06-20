"use client";

import { useState } from "react";
import { SITE } from "@/lib/site";

const ITEMS: { q: string; a: React.ReactNode }[] = [
  {
    q: "How are portfolios ranked?",
    a: (
      <>
        Head-to-head votes feed an ELO rating (like chess). An AI casts the first
        rounds so the board isn&apos;t empty, then people refine it.{" "}
        <a href="/how" className="text-accent hover:underline">
          Full explanation →
        </a>
      </>
    ),
  },
  {
    q: "How does the AI grade them?",
    a: "Gemini looks at each site's screenshot and scores design, clarity, storytelling, writing, memorability, and motion — and folds in real Lighthouse + polish data when it compares two. It judges how a site looks, so it only seeds the ranking; humans get the final say.",
  },
  {
    q: "Why do I have to sign in to vote?",
    a: "So one person is one vote. Anonymous visitors get a few practice votes; signing in (GitHub/Google) is what makes a crowd ranking trustworthy. Your practice votes convert when you sign in.",
  },
  {
    q: "What are Superstars (⭐)?",
    a: "You earn one ⭐ every 5 votes. Spend it on a site you think is exceptional — it counts double and adds a visible ⭐ to that portfolio's 'Most Loved' tally.",
  },
  {
    q: "Why does it judge screenshots instead of the live site?",
    a: "So a vote takes ~5 seconds and never makes you leave. We capture a real desktop + mobile screenshot of every site; objective measures (Lighthouse, polish) run live and are cached on each detail page.",
  },
  {
    q: "My portfolio is on here — how do I get it off?",
    a: (
      <>
        No problem —{" "}
        <a
          href={SITE.remove}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          request removal
        </a>{" "}
        and it&apos;s dropped from the grid, voting, and leaderboard for good.
      </>
    ),
  },
  {
    q: "How do I get added?",
    a: (
      <>
        <a
          href={SITE.submit}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          Submit it
        </a>{" "}
        — it flows in, gets screenshotted and graded automatically.
      </>
    ),
  },
];

export function FAQ() {
  // Accordion: one panel open at a time. Animated open/close via the
  // grid-template-rows 0fr→1fr trick (see .accordion-panel in globals.css).
  const [open, setOpen] = useState<number | null>(null);

  return (
    <section className="mx-auto mt-16 max-w-3xl">
      <h2 className="mb-4 text-center text-lg font-semibold">FAQ</h2>
      <div className="space-y-2">
        {ITEMS.map((it, i) => {
          const isOpen = open === i;
          return (
            <div
              key={it.q}
              className="overflow-hidden rounded-xl border border-edge bg-card"
            >
              <button
                id={`faq-q-${i}`}
                onClick={() => setOpen(isOpen ? null : i)}
                aria-expanded={isOpen}
                aria-controls={`faq-a-${i}`}
                className="flex w-full cursor-pointer items-center justify-between px-4 py-3 text-left text-sm font-semibold"
              >
                {it.q}
                <span
                  className={`ml-3 shrink-0 text-mute transition-transform duration-300 ${
                    isOpen ? "rotate-180" : ""
                  }`}
                >
                  ⌄
                </span>
              </button>
              <div
                id={`faq-a-${i}`}
                aria-labelledby={`faq-q-${i}`}
                // `inert` while collapsed keeps the zero-height answer (and any
                // links inside it) out of the tab order and the a11y tree.
                inert={!isOpen}
                className={`accordion-panel grid transition-all duration-300 ease-out ${
                  isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                }`}
              >
                <div className="overflow-hidden">
                  <p className="px-4 pb-3 text-sm leading-relaxed text-mute">
                    {it.a}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
