import { isPublicHttpUrl } from "@/lib/safefetch";
import { testSeam } from "@/lib/grader/server";

// One request to a portfolio, never following a redirect (lib/ownership/verify.mjs
// follows them by hand, on the same site only), for the ownership check and
// the existence check of "Add your portfolio". Every hop shares one deadline,
// so the whole check never takes longer than `timeoutMs`. Private and local
// addresses are refused (lib/net-guard.mjs), and on Workers
// global_fetch_strictly_public also refuses names that resolve to them. In
// the test runs, GRADER_TEST_SITE stands in for the internet (lib/test-mode.mjs).

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
};

/** A `hop(url)` for fetchSameSite with one deadline for all its hops. */
export function siteHop(timeoutMs: number): (url: string) => Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  const base = testSeam("GRADER_TEST_SITE");
  return async (url: string) => {
    if (base) return fetch(`${base}/site?u=${encodeURIComponent(url)}`, { redirect: "manual", signal, headers: HEADERS });
    if (!isPublicHttpUrl(url)) throw new Error("unreachable");
    return fetch(url, { redirect: "manual", signal, headers: HEADERS });
  };
}
