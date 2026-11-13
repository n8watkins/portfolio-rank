import { NextResponse } from "next/server";
import { ensureSchema } from "@/lib/db";
import { PRIVATE, graderFetcher } from "@/lib/grader/server";
import { measureQuick, type QuickFacts } from "@/lib/grader/quick";
import { checklistItems } from "@/lib/tools/checklist";
import { answerHead, gate, readFresh, remember, reserve, store, wantsFresh } from "@/lib/tools/server";
import { quickKey } from "@/lib/tools/keys";

// The portfolio checklist (/tools/portfolio-checklist): the free code checks
// of "grade my portfolio" (lib/grader/quick.ts) with a plain fix for each
// (lib/tools/checklist.ts; docs/TOOLS.md).
//
// POST /api/tools/checklist { url, turnstileToken, fresh? }
//   200 { url, listed, profile?, checklist: { ok, error?, message?, items?, measuredAt }, discovery }
//   400, 403, 404, 429: as /api/tools/speed
//
// Saved under the grader's own key ("grader:quick:<site key>"), so a grade
// asked for the same day reuses it, and reused for a day unless fresh; a
// run takes one "page" check of the daily caps (lib/tools/caps.mjs).
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await gate(req, "tools");
  if (g instanceof Response) return g;
  await ensureSchema();

  let quick: QuickFacts | null = wantsFresh(g) ? null : await readFresh<QuickFacts>(quickKey(g.siteKey));
  if (!quick?.ok) {
    const refused = await reserve(g, "page");
    if (refused) return refused;
    const at = Date.now();
    quick = await measureQuick(g.url, { fetcher: graderFetcher(), now: new Date(at) });
    if (quick.ok) await store(quickKey(g.siteKey), quick, at);
  }

  const checklist = quick.ok
    ? { ok: true, items: checklistItems(quick), measuredAt: quick.measuredAt, ...(quick.message ? { message: quick.message } : {}) }
    : { ok: false, error: quick.error, message: quick.message, measuredAt: quick.measuredAt };
  const discovery = await remember(g, quick.ok);
  return NextResponse.json({ ...answerHead(g), checklist, discovery }, { headers: PRIVATE });
}
