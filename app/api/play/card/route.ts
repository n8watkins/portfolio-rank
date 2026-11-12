import { NextResponse } from "next/server";
import { isHidden, isKnownPortfolio } from "@/lib/roster";
import { playDetails } from "@/lib/play/card";
import { cachedResponse } from "@/lib/edge-cache";

// GET /api/play/card?url=<listed portfolio> -> the inline Details panel of
// the face-off and Guess the percentile (lib/play/card.ts playDetails):
// public grade, the hiring manager's checks, the AI's notes, the face-off
// record and the share card's address. Public and the same for everyone, so
// it is kept at the edge for 5 minutes. Unknown, hidden and removed sites
// answer 404.
export const dynamic = "force-dynamic";

const MAX_AGE = 300;

export async function GET(req: Request) {
  const self = new URL(req.url);
  const url = self.searchParams.get("url") ?? "";
  if (!isKnownPortfolio(url) || (await isHidden(url))) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return cachedResponse(`${self.origin}/api/play/card?url=${encodeURIComponent(url)}`, async () =>
    NextResponse.json(await playDetails(url), { headers: { "cache-control": `public, max-age=${MAX_AGE}` } })
  );
}
