import { db } from "@/lib/db";
import type { QuickFacts } from "@/lib/grader/quick";
import { siteKeyOf } from "@/lib/grader/url.mjs";
import type { PsiResult } from "./psi";
import type { ShareResult } from "./share";
import { checklistItems } from "./checklist";
import { psiKey, quickKey, shareKey } from "./keys";

// "To improve": the failed or weak items of a portfolio's saved results
// (Lighthouse, the share card, the free checks), each pointing at the tool
// that explains it and re-tests it. Derived on read from the cache table,
// so re-running a tool (which saves under the same key) clears the item;
// nothing is stored or sent for it.

export type Improvement = {
  id: string;
  /** One plain line: what's wrong. */
  title: string;
  /** Where to see it, fix it and test again. */
  href: string;
  tool: "Speed check" | "Share preview checker" | "Portfolio checklist";
};

export const TOOL_HREF = { speed: "/tools/speed", share: "/tools/share-preview", checklist: "/tools/portfolio-checklist" } as const;

const withUrl = (path: string, url: string) => `${path}?url=${encodeURIComponent(url)}`;

/** Scores under this are worth fixing (Lighthouse's own "needs work" line is 90; below 50 is poor). */
const WEAK = { performance: 50, accessibility: 90, "best-practices": 90, seo: 90 } as const;
const CATEGORY_WORDS: Record<string, string> = {
  performance: "is slow on phones",
  accessibility: "has accessibility problems",
  "best-practices": "misses web best practices",
  seo: "is hard for search engines to read",
};

/** The improvements for one site from its saved results. Pure: the tests call it with plain objects. */
export function improvements(url: string, saved: { mobile?: PsiResult | null; share?: ShareResult | null; quick?: QuickFacts | null }): Improvement[] {
  const out: Improvement[] = [];
  const quick = saved.quick?.ok ? saved.quick : null;
  for (const item of quick ? checklistItems(quick) : []) {
    if (item.pass === false) out.push({ id: `checklist:${item.id}`, title: `${item.label}: ${item.found.charAt(0).toLowerCase()}${item.found.slice(1)}`, href: withUrl(TOOL_HREF.checklist, url), tool: "Portfolio checklist" });
  }
  const share = saved.share?.ok ? saved.share : null;
  for (const issue of share?.issues ?? []) {
    if (issue.level === "fix") out.push({ id: `share:${issue.id}`, title: issue.title, href: withUrl(TOOL_HREF.share, url), tool: "Share preview checker" });
  }
  const m = saved.mobile?.ok ? saved.mobile : null;
  for (const [id, line] of Object.entries(WEAK)) {
    const score = m?.scores?.[id];
    if (typeof score === "number" && score < line) {
      out.push({ id: `speed:${id}`, title: `Your site ${CATEGORY_WORDS[id]} (${score} of 100 on mobile)`, href: withUrl(TOOL_HREF.speed, url), tool: "Speed check" });
    }
  }
  return out;
}

/** Reads a site's saved results (one query) and derives its improvements. */
export async function improvementsFor(url: string): Promise<Improvement[]> {
  const keys = [psiKey("mobile", url), shareKey(url), quickKey(siteKeyOf(url))];
  const rows = (await db().execute({ sql: `SELECT k, v FROM cache WHERE k IN (?, ?, ?)`, args: keys })).rows;
  const by = new Map(rows.map((r) => [String(r.k), String(r.v)]));
  const parse = <T,>(k: string): T | null => {
    try {
      const v = by.get(k);
      return v ? (JSON.parse(v) as T) : null;
    } catch {
      return null;
    }
  };
  return improvements(url, { mobile: parse<PsiResult>(keys[0]), share: parse<ShareResult>(keys[1]), quick: parse<QuickFacts>(keys[2]) });
}
