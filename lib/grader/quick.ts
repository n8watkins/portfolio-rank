import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { safeFetch, readCapped } from "@/lib/safefetch";
import { checkLinks, extractLinks, linkContext, measureFacts, projectLinkCandidates } from "@/pipeline/facts.mjs";
import { parkingPhrase, titleOf, visibleText } from "@/pipeline/gate.mjs";
import { codeChecks } from "@/pipeline/rubric.mjs";

// The free checks of "grade my portfolio", from the Worker at once (owner
// decision 2026-11-10: a plain fetch, no browser, no Gemini): is the page
// up, and the facts code can check from its HTML (pipeline/facts.mjs:
// resume, GitHub, contact, project links that load, own domain, footer
// year, template), plus a fingerprint of the page's structure that the
// re-grade cooldown compares.
//
// Every fetch goes through safeFetch (lib/safefetch.ts): redirects followed
// by hand with every hop re-checked against private addresses, the body
// read up to a cap, a time limit; global_fetch_strictly_public also stops
// names that resolve to private addresses. Results are cached per address
// for a day (failures for 10 minutes) in the cache table, so the same
// address is fetched at most once a day however often it is asked for.

export const QUICK_TTL_MS = 24 * 60 * 60 * 1000;
export const QUICK_FAIL_TTL_MS = 10 * 60 * 1000;
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
  fingerprint?: string | null;
  measuredAt: string;
};

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

/** A structural fingerprint of the HTML: the tag sequence and the class names. */
export function htmlFingerprint(html: string): string | null {
  const tags = [...html.matchAll(/<([a-z][a-z0-9-]*)\b/gi)].slice(0, 3000).map((m) => m[1].toLowerCase());
  if (tags.length < 5) return null;
  const classes = new Set<string>();
  for (const m of html.matchAll(/\bclass\s*=\s*["']([^"']*)["']/gi)) for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
  return createHash("sha1").update(`${tags.join(",")}:${[...classes].sort().slice(0, 500).join(",")}`).digest("hex").slice(0, 20);
}

/** Runs the free checks on one address (uncached). */
export async function measureQuick(url: string, { fetcher = publicFetcher, now = new Date() }: { fetcher?: Fetcher; now?: Date } = {}): Promise<QuickFacts> {
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
  const links = extractLinks(html, finalUrl);
  const urls = projectLinkCandidates(links, finalUrl);
  // Which links failed, why, and where on the page (the report lists them).
  facts.project_links = await checkLinks(urls, { fetchImpl: linkFetch(fetcher) as unknown as typeof fetch, timeoutMs: LINK_TIMEOUT_MS, context: linkContext(links) });
  // Client-rendered pages send little HTML: the capture measures them properly.
  return {
    ok: true,
    finalUrl,
    httpStatus: res.status,
    title,
    facts,
    checks: codeChecks(facts, now),
    fingerprint: htmlFingerprint(html),
    measuredAt,
    ...(text.length < 30 ? { message: "The page sends almost no text without JavaScript; the screenshot step reads the rendered page." } : {}),
  };
}


/** The free checks for a site address, cached for a day per address (failures for 10 minutes). */
export async function quickFacts(db: Client, { url, siteKey, fetcher, now = Date.now() }: { url: string; siteKey: string; fetcher?: Fetcher; now?: number }): Promise<QuickFacts & { cached: boolean }> {
  const k = `grader:quick:${siteKey}`;
  const row = (await db.execute({ sql: "SELECT v, at FROM cache WHERE k = ?", args: [k] })).rows[0];
  if (row) {
    try {
      const v = JSON.parse(String(row.v)) as QuickFacts;
      if (now - Number(row.at) < (v.ok ? QUICK_TTL_MS : QUICK_FAIL_TTL_MS)) return { ...v, cached: true };
    } catch {
      /* measure again */
    }
  }
  const v = await measureQuick(url, { fetcher, now: new Date(now) });
  await db.execute({ sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, ?, ?)", args: [k, JSON.stringify(v), now] });
  return { ...v, cached: false };
}
