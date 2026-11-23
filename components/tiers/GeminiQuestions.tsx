import { Bot } from "lucide-react";

// What the AI model does, for both grading pages (app/grading/page.tsx with
// RANKING_V2 off, components/tiers/EloGrading.tsx with it on), owner
// 2026-11-23: rank and tier come from code measurements and votes; the model
// is used for one decision only, whether a page is a portfolio at all. The
// roles it also names are not shown and set nothing.

export function GeminiQuestions() {
  return (
    <>
      <h3 className="flex items-center gap-2 font-bold">
        <Bot className="h-4 w-4 text-mute" aria-hidden /> AI: is it a portfolio?
      </h3>
      <p className="mt-2 text-sm text-mute">
        An AI model is used for one decision only: whether a page is a portfolio at all, one that shows projects the person built. It never sets a
        rank or a tier.
      </p>
      <p className="mt-2 text-sm text-mute">A &ldquo;no&rdquo; can take a site off the list, with a record the owner can undo.</p>
    </>
  );
}
