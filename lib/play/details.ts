import type { Inspection } from "@/app/api/inspect/route";
import type { PsiResult } from "@/app/api/psi/route";
import { peekCached } from "@/lib/cache";
import { CHECK_KINDS } from "@/lib/freshness.mjs";
import { playDetails, type PlayDetails } from "@/lib/play/card";

// Everything Play shows about a site, from what is already stored, in one
// answer: the polish check (/api/inspect's cache), both Lighthouse results
// (/api/psi's cache, mobile and desktop) and its card (record, ELO, projects).
// Never fetches the site and never runs PageSpeed: a miss is null, and the
// browser fills it once through /api/inspect or /api/psi. It rides along with
// each face-off pair (/api/rank) and answers /api/play/details, so a card
// costs no requests of its own.

/** The same rules as /api/inspect and /api/psi (lib/freshness.mjs; only read here, never changed). */
const failed = (d: { ok: boolean }) => !d.ok;

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
        peekCached<Inspection>("inspect", url, CHECK_KINDS.polish.maxAgeMs, { isFailure: failed, freshness: { kind: "polish", url } }).catch(() => null),
        peekCached<PsiResult>("psi", url, CHECK_KINDS.lighthouse.maxAgeMs, { isFailure: failed, freshness: { kind: "lighthouse", url } }).catch(() => null),
        peekCached<PsiResult>("psi-desktop", url, CHECK_KINDS.lighthouse.maxAgeMs, { isFailure: failed, freshness: { kind: "lighthouse", url } }).catch(() => null),
        playDetails(url).catch(() => null),
      ]);
      out[url] = { inspect, psi: { mobile, desktop }, card };
    })
  );
  return out;
}
