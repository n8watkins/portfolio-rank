import { NextResponse } from "next/server";
import { isHidden, isKnownPortfolio } from "@/lib/roster";
import { siteDetails } from "@/lib/play/details";

// GET /api/play/details?url=<url>[&url=<url>] -> { details: { <url>: SiteDetails } }
// What Play shows about up to two listed sites, from storage only
// (lib/play/details.ts). The face-off gets the same with each pair from
// /api/rank; this answers Guess the percentile and the face-off's slow poll
// while a measurement is still running. Unknown or hidden sites are left out.
export const dynamic = "force-dynamic";

const MAX = 2;

export async function GET(req: Request) {
  const asked = new URL(req.url).searchParams.getAll("url");
  const urls = [...new Set(asked.map((u) => u.trim()).filter(Boolean))].slice(0, MAX);
  const listed: string[] = [];
  for (const u of urls) if (isKnownPortfolio(u) && !(await isHidden(u))) listed.push(u);
  if (!listed.length) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ details: await siteDetails(listed) }, { headers: { "cache-control": "no-store" } });
}
