import type { Inspection } from "@/app/api/inspect/route";
import type { PsiResult } from "@/app/api/psi/route";
import { peekCached } from "@/lib/cache";
import { playDetails, type PlayDetails } from "@/lib/play/card";

// Everything Play shows about a site, from what is already stored, in one
// answer: the polish check (/api/inspect's cache), both Lighthouse results
// (/api/psi's cache, mobile and desktop) and its card (record, ELO, projects).
// Never fetches the site and never runs PageSpeed: a miss is null, and the
// browser fills it once through /api/inspect or /api/psi. It rides along with
// each face-off pair (/api/rank) and answers /api/play/details, so a card
// costs no requests of its own.

/** The same lifetimes as /api/inspect and /api/psi (only read here, never changed). */
const INSPECT_TTL_MS = 7 * 24 * 3600 * 1000;
const PSI_TTL_MS = 30 * 24 * 3600 * 1000;

export type SiteDetails = {
  inspect: Inspection | null;
  psi: { mobile: PsiResult | null; desktop: PsiResult | null };
  card: PlayDetails | null;
};

export async function siteDetails(urls: string[]): Promise<Record<string, SiteDetails>> {
  const out: Record<string, SiteDetails> = {};
  await Promise.all(
    urls.map(async (url) => {
      const [inspect, mobile, desktop, card] = await Promise.all([
        peekCached<Inspection>("inspect", url, INSPECT_TTL_MS).catch(() => null),
        peekCached<PsiResult>("psi", url, PSI_TTL_MS).catch(() => null),
        peekCached<PsiResult>("psi-desktop", url, PSI_TTL_MS).catch(() => null),
        playDetails(url).catch(() => null),
      ]);
      out[url] = { inspect, psi: { mobile, desktop }, card };
    })
  );
  return out;
}
