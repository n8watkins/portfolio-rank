import { graderFetcher } from "@/lib/grader/server";
import { measureQuick, type QuickFacts } from "@/lib/grader/quick";
import { runPsi, type PsiResult } from "./psi";
import { checkShare, type ShareResult } from "./share";
import { psiKey, quickKey, shareKey } from "./keys";
import { reserveTool, toolCaps } from "./caps.mjs";
import { db } from "@/lib/db";
import { store } from "./server";

// Every check on one site at once (owner, 2026-11-12: "Add your portfolio"
// and "Re-check my site" run them all): the free checks (checklist), the
// share card and Lighthouse on mobile and desktop. Each good result is
// saved under the key the profile reads (lib/tools/keys.ts); a failure never
// replaces a good result. The caller has checked the request (Turnstile, or
// a signed-in owner) and the caps are reserved here: the page checks must
// fit, and Lighthouse runs only when the speed cap has room (else the
// profile keeps its last result and says when it was measured).

export type CheckRun = {
  quick: QuickFacts;
  share: ShareResult;
  mobile: PsiResult | null;
  desktop: PsiResult | null;
  /** Lighthouse was skipped: the day's speed checks are used up. */
  speedSkipped: boolean;
};

export type Who = { visitor: string; network: string; network48: string };

/** Reserves the page checks; false when a cap is reached (scope says which). */
export async function reservePage(who: Who) {
  return reserveTool(db(), { tool: "page", ...who, caps: toolCaps(process.env.TOOLS_CAPS) });
}

/** Runs every check on `url` (site key `siteKey`) and saves the results. Never throws for a site that misbehaves. */
export async function runAllChecks({ url, siteKey }: { url: string; siteKey: string }, who: Who): Promise<CheckRun> {
  const at = Date.now();
  const speed = await reserveTool(db(), { tool: "speed", ...who, caps: toolCaps(process.env.TOOLS_CAPS) });
  const fetcher = graderFetcher();
  const [quick, share, mobile, desktop] = await Promise.all([
    measureQuick(url, { fetcher, now: new Date(at) }),
    checkShare(url, { fetcher }),
    speed.ok ? runPsi(url, "mobile") : Promise.resolve(null),
    speed.ok ? runPsi(url, "desktop") : Promise.resolve(null),
  ]);
  const saves: Promise<void>[] = [];
  if (quick.ok) saves.push(store(quickKey(siteKey), quick, at));
  if (share.ok) saves.push(store(shareKey(url), share, at));
  if (mobile?.ok) saves.push(store(psiKey("mobile", url), mobile, at));
  if (desktop?.ok) saves.push(store(psiKey("desktop", url), desktop, at));
  await Promise.all(saves);
  return { quick, share, mobile, desktop, speedSkipped: !speed.ok };
}
