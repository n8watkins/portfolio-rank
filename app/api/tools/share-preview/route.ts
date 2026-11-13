import { NextResponse } from "next/server";
import { ensureSchema } from "@/lib/db";
import { PRIVATE, graderFetcher } from "@/lib/grader/server";
import { checkShare, type ShareResult } from "@/lib/tools/share";
import { answerHead, gate, readFresh, remember, reserve, store, wantsFresh } from "@/lib/tools/server";
import { shareKey } from "@/lib/tools/keys";

// The share preview checker (/tools/share-preview): the card LinkedIn,
// Slack and X build from a page's title, description and share image, and
// what to fix (lib/tools/share.ts; docs/TOOLS.md).
//
// POST /api/tools/share-preview { url, turnstileToken, fresh? }
//   200 { url, listed, profile?, share, discovery }
//       share is ShareResult; { ok: false, error } when the page can't be read
//   400, 403, 404, 429: as /api/tools/speed
//
// Saved under "share:<url>" (the listed address for a listed portfolio),
// reused for a day unless fresh; a run takes one "page" check of the daily
// caps (lib/tools/caps.mjs).
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await gate(req, "tools");
  if (g instanceof Response) return g;
  await ensureSchema();

  let share: ShareResult | null = wantsFresh(g) ? null : await readFresh<ShareResult>(shareKey(g.url));
  if (!share?.ok) {
    const refused = await reserve(g, "page");
    if (refused) return refused;
    const at = Date.now();
    const result = await checkShare(g.url, { fetcher: graderFetcher() });
    if (result.ok) await store(shareKey(g.url), result, at);
    share = { ...result, measuredAt: new Date(at).toISOString() };
  }

  const discovery = await remember(g, share.ok);
  return NextResponse.json({ ...answerHead(g), share, discovery }, { headers: PRIVATE });
}
