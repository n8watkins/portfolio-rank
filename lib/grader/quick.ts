import type { Client } from "@libsql/client";
import { safeFetch, readCapped } from "@/lib/safefetch";
import { checkLinks, extractLinks, measureFacts, projectLinkCandidates } from "@/pipeline/facts.mjs";
import { parkingPhrase, titleOf, visibleText } from "@/pipeline/gate.mjs";
import { codeChecks } from "@/pipeline/rubric.mjs";
import { CHECK_KINDS, pageFingerprint, recordCheck } from "@/lib/freshness.mjs";

// The free checks of "grade my portfolio", from the Worker at once (owner
// decision 2026-11-10: a plain fetch, no browser, no Gemini): is the page
// up, and the facts code can check from its HTML (pipeline/facts.mjs:
// resume, GitHub, contact, project links that load, own domain, footer
// year, template), plus the page's change fingerprint (lib/freshness.mjs)
// that the re-grade cooldown compares.
//
// Every fetch goes through safeFetch (lib/safefetch.ts): redirects followed
// by hand with every hop re-checked against private addresses, the body
// read up to a cap, a time limit; global_fetch_strictly_public also stops
// names that resolve to private addresses.
//
// When they run again (AUTOMATION.md "When checks re-run"): a request is a
// grade, so the page itself is always fetched again (that one fetch is the
// change fingerprint, and the cooldown must see today's page); the project
// link checks are reused while the fingerprint is unchanged and they are
// under 30 days old. A failure (unreachable, parked, an error) is reused for
// 10 minutes, so asking again and again doesn't fetch the site again.

export const QUICK_FAIL_TTL_MS = CHECK_KINDS.freeChecks.failureRetryMs;
export const LINKS_MAX_AGE_MS = CHECK_KINDS.freeChecks.maxAgeMs;
export const HTML_MAX_BYTES = 1_500_000;
const PAGE_TIMEOUT_MS = 10_000;
const LINK_TIMEOUT_MS = 5_000;

export type QuickFacts = {
  ok: boolean;
  /** Why the page can't be graded (ok false): a short code and a sentence. */
  error?: "unreachable" | "http_error" | "not_html" | "parked" | "blank";
  message?: string;
  finalUrl?: string;
  httpStatus?: number;
  title?: string;
  /** Measured facts (pipeline/facts.mjs), source "http". */
  facts?: Record<string, unknown>;
  /** Pass/fail/unknown per code criterion (pipeline/rubric.mjs codeChecks). */
  checks?: Record<string, boolean | null> | null;
  /** The page's change fingerprint (lib/freshness.mjs pageFingerprint hash). */
  fingerprint?: string | null;
  /** When the project links were checked: now, or an earlier check reused while the page was unchanged. */
  linksCheckedAt?: string;
  measuredAt: string;
};

/** An earlier answer whose link checks may be reused. */
type Reuse = Pick<QuickFacts, "fingerprint" | "linksCheckedAt" | "facts">;

type Fetched = { res: Response; finalUrl: string } | null;
export type Fetcher = (url: string, init: { method?: string; timeoutMs: number }) => Promise<Fetched>;

/** The default fetcher: safeFetch. */
export const publicFetcher: Fetcher = (url, init) => safeFetch(url, init);

/** A fetch-like function over a Fetcher, for checkLinks (HEAD then GET, redirects re-checked). */
function linkFetch(fetcher: Fetcher) {
  return async (url: string, init: { method?: string; signal?: AbortSignal } = {}) => {
    const got = await fetcher(url, { method: init.method ?? "GET", timeoutMs: LINK_TIMEOUT_MS });
    if (!got) throw new Error("blocked or unreachable");
    return got.res;
  };
}

/** Runs the free checks on one address (uncached). */
export async function measureQuick(
  url: string,
  { fetcher = publicFetcher, now = new Date(), reuse = null }: { fetcher?: Fetcher; now?: Date; reuse?: Reuse | null } = {}
): Promise<QuickFacts & { fp?: ReturnType<typeof pageFingerprint> }> {
  const measuredAt = now.toISOString();
  const got = await fetcher(url, { timeoutMs: PAGE_TIMEOUT_MS });
  if (!got) return { ok: false, error: "unreachable", message: "We couldn't reach that address (it didn't answer, or it points somewhere we don't visit).", measuredAt };
  const { res, finalUrl } = got;
  if (res.status >= 400) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, error: "http_error", httpStatus: res.status, finalUrl, message: `The page answered with an error (HTTP ${res.status}).`, measuredAt };
  }
  const type = res.headers.get("content-type") ?? "";
  if (type && !/text\/html|application\/xhtml/i.test(type)) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, error: "not_html", finalUrl, httpStatus: res.status, message: "That address isn't a web page.", measuredAt };
  }
  const html = await readCapped(res, HTML_MAX_BYTES);
  const text = visibleText(html);
  const title = titleOf(html).slice(0, 200);
  if (parkingPhrase({ html, text, title } as never)) {
    return { ok: false, error: "parked", finalUrl, httpStatus: res.status, title, message: "That domain looks parked or for sale.", measuredAt };
  }
  // measureFacts is plain JavaScript; its inferred parameter type is narrower than what it reads.
  const facts = measureFacts({ html, text, url, finalUrl, source: "http", now } as never) as Record<string, unknown>;
  const fp = pageFingerprint({ html, finalUrl, headers: res.headers, now: now.getTime() });
  // The link checks are the slow part: an unchanged page reuses them for 30 days.
  const linksAt = reuse?.linksCheckedAt ? Date.parse(reuse.linksCheckedAt) : NaN;
  let linksCheckedAt = measuredAt;
  if (reuse?.fingerprint === fp.hash && reuse.facts?.project_links && now.getTime() - linksAt < LINKS_MAX_AGE_MS) {
    facts.project_links = reuse.facts.project_links;
    linksCheckedAt = reuse.linksCheckedAt!;
  } else {
    const urls = projectLinkCandidates(extractLinks(html, finalUrl), finalUrl);
    facts.project_links = await checkLinks(urls, { fetchImpl: linkFetch(fetcher) as unknown as typeof fetch, timeoutMs: LINK_TIMEOUT_MS });
  }
  // Client-rendered pages send little HTML: the capture measures them properly.
  return {
    ok: true,
    finalUrl,
    httpStatus: res.status,
    title,
    facts,
    checks: codeChecks(facts, now),
    fingerprint: fp.hash,
    linksCheckedAt,
    measuredAt,
    fp,
    ...(text.length < 30 ? { message: "The page sends almost no text without JavaScript; the screenshot step reads the rendered page." } : {}),
  };
}


/**
 * The free checks for a site address. A failure is reused for 10 minutes;
 * otherwise the page is fetched again and only the link checks of an
 * unchanged page are reused (see the header). For a listed portfolio
 * (`listedUrl`), the fetch also records its change fingerprint, so the
 * leaderboard's checks of a site its owner just changed are due again.
 */
export async function quickFacts(
  db: Client,
  { url, siteKey, fetcher, now = Date.now(), listedUrl = null }: { url: string; siteKey: string; fetcher?: Fetcher; now?: number; listedUrl?: string | null }
): Promise<QuickFacts & { cached: boolean }> {
  const k = `grader:quick:${siteKey}`;
  const row = (await db.execute({ sql: "SELECT v, at FROM cache WHERE k = ?", args: [k] })).rows[0];
  let reuse: Reuse | null = null;
  if (row) {
    try {
      const v = JSON.parse(String(row.v)) as QuickFacts;
      if (!v.ok && now - Number(row.at) < QUICK_FAIL_TTL_MS) return { ...v, cached: true };
      if (v.ok) reuse = v;
    } catch {
      /* measure again */
    }
  }
  const { fp, ...v } = await measureQuick(url, { fetcher, now: new Date(now), reuse });
  await db.execute({ sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, ?, ?)", args: [k, JSON.stringify(v), now] });
  if (fp && listedUrl) await recordCheck(db, listedUrl, fp, { now }).catch(() => {});
  return { ...v, cached: false };
}
