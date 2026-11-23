import { Bot } from "lucide-react";

// What the AI check does, for both grading pages (app/grading/page.tsx with
// RANKING_V2 off, components/tiers/EloGrading.tsx with it on), owner
// 2026-11-23: no model decides anything in normal running; rank, tier and
// listing come from code measurements, votes and the owner's own review. The
// check that asks whether a page is a portfolio exists, switched off.

export function GeminiQuestions() {
  return (
    <>
      <h3 className="flex items-center gap-2 font-bold">
        <Bot className="h-4 w-4 text-mute" aria-hidden /> The AI check is switched off
      </h3>
      <p className="mt-2 text-sm text-mute">
        Rank, tier and listing come from code measurements, people&apos;s votes and the owner&apos;s own review. No AI model decides anything.
      </p>
      <p className="mt-2 text-sm text-mute">
        An AI check that asks whether a page is a portfolio at all exists, but it is switched off. Even when on, it never sets a rank or a tier.
      </p>
    </>
  );
}
