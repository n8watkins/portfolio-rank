import type { Metadata } from "next";
import { ShieldCheck } from "lucide-react";
import feed from "@/data/feed.json";
import { ClaimFlow } from "@/components/claim/ClaimFlow";
import { btnPrimary } from "@/components/ui/styles";
import { gamesEnabled } from "@/lib/games/server";
import { isKnownPortfolio } from "@/lib/roster";
import { heroOf, shotBases } from "@/lib/shots";

// Claim your portfolio: /claim?url=<a listed portfolio>, or /claim to find it
// by its address (Settings, "Remove my portfolio"). Always on, so an owner can
// prove a site is theirs and hide its grade or remove it whatever the feature
// switches say; only the re-grade waits for the games (GAMES_V2). The steps
// and the owner's actions run in the browser on /api/owner/claims and
// /api/owner/actions; this page only finds the site on the list and draws it.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Claim your portfolio - PortfolioRank", robots: { index: false, follow: false } };

const FEED = feed as { name: string; url: string }[];

const hostOf = (s: string) => {
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

/** The listed portfolio an address means: the exact URL, else the same host. */
function find(input: string) {
  const exact = FEED.find((p) => p.url === input);
  if (exact) return exact;
  const host = hostOf(input.trim());
  return host ? FEED.find((p) => hostOf(p.url) === host) : undefined;
}

export default async function ClaimPage({ searchParams }: { searchParams: Promise<{ url?: string }> }) {
  const asked = (await searchParams).url;
  const found = typeof asked === "string" && asked.trim() ? find(asked.slice(0, 500)) : undefined;
  const site = found && isKnownPortfolio(found.url) ? found : undefined;
  if (!site) {
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-12 sm:px-6 sm:py-16">
        <section aria-labelledby="find" className="card p-5 sm:p-6">
          <span className="icon-tile h-10 w-10">
            <ShieldCheck className="h-5 w-5" aria-hidden />
          </span>
          <h1 id="find" className="mt-3 text-2xl font-bold tracking-tight">
            Remove or manage your portfolio
          </h1>
          <p className="mt-2 text-sm text-mute">
            First prove it&apos;s yours: a link to your GitHub profile on the site, or a short code you add to the page. Then, with the code, you can hide its grade or remove it.
          </p>
          <form method="get" className="mt-5 flex flex-col gap-2 sm:flex-row">
            <label className="sr-only" htmlFor="claim-url">
              Your portfolio address
            </label>
            <input
              id="claim-url"
              name="url"
              defaultValue={typeof asked === "string" ? asked.slice(0, 500) : ""}
              placeholder="yourname.dev"
              autoComplete="url"
              required
              className="h-11 min-w-0 flex-1 rounded-lg border border-edge bg-bg px-3 text-sm outline-none focus:border-accent"
            />
            <button type="submit" className={btnPrimary}>
              Find it
            </button>
          </form>
          {typeof asked === "string" && asked.trim() && (
            <p role="status" className="mt-3 text-sm text-down">
              That address isn&apos;t on the list. Check the spelling, or it may already be removed.
            </p>
          )}
        </section>
      </div>
    );
  }
  const url = site.url;
  const domain = hostOf(url) || url;
  const shots = await shotBases([url]);
  return <ClaimFlow url={url} name={site.name ?? domain} domain={domain} hero={shots.has(url) ? heroOf(shots.get(url)!) : null} regrade={gamesEnabled()} />;
}
