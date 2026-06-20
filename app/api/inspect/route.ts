import { NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { isKnownPortfolio } from "@/lib/roster";
import { safeFetch, readCapped } from "@/lib/safefetch";

export const runtime = "nodejs";

const FREE_HOSTS =
  /\.(vercel\.app|netlify\.app|github\.io|framer\.website|framer\.app|pages\.dev|web\.app|surge\.sh|onrender\.com|herokuapp\.com)$/i;

export type Inspection = {
  ok: boolean;
  error?: string;
  finalUrl?: string;
  https?: boolean;
  customDomain?: boolean;
  title?: string | null;
  description?: string | null;
  ogTitle?: string | null;
  ogDescription?: string | null;
  ogImage?: string | null;
  ogImageLoads?: boolean;
  favicon?: boolean;
  hasGithubLink?: boolean;
  // Social profiles scraped from the page so visitors can reach them directly.
  githubUrl?: string | null;
  linkedinUrl?: string | null;
  xUrl?: string | null;
  hasResume?: boolean;
  hasContact?: boolean;
  copyrightYear?: number | null;
};

// First github.com/<user> link on the page → their profile URL. Skips GitHub's
// own non-user paths (sponsors, topics, etc.) and reserved short words.
const GH_NON_USER = /^(sponsors|topics|features|about|pricing|marketplace|orgs|organizations|settings|notifications|explore|login|join|new|search|apps|collections|readme|site|customer-stories|enterprise|team|security|contact)$/i;
function scrapeGithub(html: string): string | null {
  const m = html.match(
    /github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)/i
  );
  if (!m || GH_NON_USER.test(m[1])) return null;
  return `https://github.com/${m[1]}`;
}

function scrapeLinkedin(html: string): string | null {
  const m = html.match(/linkedin\.com\/(in\/[A-Za-z0-9_%-]+|company\/[A-Za-z0-9_%-]+)/i);
  if (!m) return null;
  const handle = m[1].split("/")[1] ?? "";
  if (handle.length < 2 || !/[a-z0-9]/i.test(handle)) return null; // skip junk slugs
  return `https://www.linkedin.com/${m[1]}`;
}

const X_NON_USER = /^(home|share|intent|hashtag|search|explore|notifications|messages|settings|login|signup|i)$/i;
function scrapeX(html: string): string | null {
  const m = html.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})/i);
  if (!m || X_NON_USER.test(m[1])) return null;
  return `https://x.com/${m[1]}`;
}

function parseMetaTags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) {
      attrs[m[1].toLowerCase()] = m[2];
    }
    const key = attrs.property ?? attrs.name;
    if (key && attrs.content !== undefined && !(key in out)) {
      out[key.toLowerCase()] = attrs.content;
    }
  }
  return out;
}

async function inspect(target: string): Promise<Inspection> {
  // safeFetch follows redirects manually, rejecting any hop that points at a
  // private/loopback/metadata address, so a roster site can't 302 us into the
  // internal network (SSRF).
  const fetched = await safeFetch(target, { timeoutMs: 10_000 });
  if (!fetched) return { ok: false, error: "unreachable" };
  const { res, finalUrl } = fetched;
  if (!res.ok) return { ok: false, error: `http_${res.status}` };

  // Cap the body so a hostile server can't OOM the function by streaming GBs.
  const html = await readCapped(res, 800_000);
  const meta = parseMetaTags(html);
  const host = new URL(finalUrl).hostname;

  const ogImage = meta["og:image"] ?? null;
  let ogImageLoads = false;
  if (ogImage) {
    const abs = new URL(ogImage, finalUrl).href;
    const img = await safeFetch(abs, { method: "HEAD", timeoutMs: 6_000 });
    ogImageLoads = Boolean(
      img?.res.ok &&
        img.res.headers.get("content-type")?.startsWith("image/")
    );
  }

  let favicon = /<link\s[^>]*rel=["'][^"']*icon[^"']*["']/i.test(html);
  if (!favicon) {
    const ico = await safeFetch(new URL("/favicon.ico", finalUrl).href, {
      method: "HEAD",
      timeoutMs: 5_000,
    });
    favicon = Boolean(ico?.res.ok);
  }

  const yearMatch = html.match(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(20\d{2})/i);
  let githubUrl = scrapeGithub(html);
  let linkedinUrl = scrapeLinkedin(html);
  let xUrl = scrapeX(html);
  // Fallback: lots of people put socials on an /about page, not the homepage.
  // One extra fetch, only when some social is still missing.
  if (!githubUrl || !linkedinUrl || !xUrl) {
    try {
      const about = await safeFetch(new URL("/about", finalUrl).href, {
        timeoutMs: 8_000,
      });
      if (about?.res.ok) {
        const ah = await readCapped(about.res, 400_000);
        githubUrl = githubUrl ?? scrapeGithub(ah);
        linkedinUrl = linkedinUrl ?? scrapeLinkedin(ah);
        xUrl = xUrl ?? scrapeX(ah);
      }
    } catch {
      /* no /about page — fine */
    }
  }

  return {
    ok: true,
    finalUrl,
    https: finalUrl.startsWith("https://"),
    customDomain: !FREE_HOSTS.test(host),
    title: html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? null,
    description: meta["description"] ?? null,
    ogTitle: meta["og:title"] ?? null,
    ogDescription: meta["og:description"] ?? null,
    ogImage,
    ogImageLoads,
    favicon,
    githubUrl,
    linkedinUrl,
    xUrl,
    hasGithubLink: Boolean(githubUrl),
    hasResume: /href=["'][^"']*(resume|\bcv\b)[^"']*["']/i.test(html),
    hasContact:
      /mailto:|href=["'][^"']*contact|<form/i.test(html) ||
      /linkedin\.com\/in\//i.test(html),
    copyrightYear: yearMatch ? Number(yearMatch[1]) : null,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url).searchParams.get("url");
  // Roster-only: prevents using this endpoint as an SSRF proxy.
  if (!url || !isKnownPortfolio(url)) {
    return NextResponse.json({ ok: false, error: "unknown_url" }, { status: 403 });
  }
  const data = await cached<Inspection>(
    "inspect",
    url,
    7 * 24 * 3600 * 1000,
    () => inspect(url)
  );
  return NextResponse.json(data);
}
