import type { Metadata } from "next";
import { notFound } from "next/navigation";
import feed from "@/data/feed.json";
import { ClaimFlow } from "@/components/claim/ClaimFlow";
import { gamesEnabled } from "@/lib/games/server";
import { isKnownPortfolio } from "@/lib/roster";
import { heroOf, shotBases } from "@/lib/shots";

// Claim your portfolio (GAMES_V2): /claim?url=<a listed portfolio>. The
// steps and the owner's actions run in the browser on /api/owner/claims and
// /api/owner/actions; this page only checks the site is on the list and
// draws it.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Claim your portfolio - PortfolioRank", robots: { index: false, follow: false } };

const FEED = feed as { name: string; url: string }[];

export default async function ClaimPage({ searchParams }: { searchParams: Promise<{ url?: string }> }) {
  if (!gamesEnabled()) notFound();
  const url = (await searchParams).url;
  if (typeof url !== "string" || !isKnownPortfolio(url)) notFound();
  const site = FEED.find((p) => p.url === url);
  let domain = url;
  try {
    domain = new URL(url).hostname.replace(/^www\./, "");
  } catch {}
  const shots = await shotBases([url]);
  return <ClaimFlow url={url} name={site?.name ?? domain} domain={domain} hero={shots.has(url) ? heroOf(shots.get(url)!) : null} />;
}
