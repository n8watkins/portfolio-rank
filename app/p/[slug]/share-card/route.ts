import { listedShareCard } from "@/lib/play/share-card";

// GET /p/<url>/share-card[?masked=1]: the portfolio's share card, as the games
// show it. masked=1 leaves out the tier and the result (Guess the percentile
// before a guess is locked in). Public, so it is cached like the Open Graph image.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const masked = new URL(req.url).searchParams.get("masked") === "1";
  const res = await listedShareCard(decodeURIComponent(slug), { masked });
  const headers = new Headers(res.headers);
  headers.set("cache-control", "public, max-age=3600");
  return new Response(res.body, { status: res.status, headers });
}
