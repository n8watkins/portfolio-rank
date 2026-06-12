import { NextResponse } from "next/server";
import { cached } from "@/lib/cache";

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
  hasResume?: boolean;
  hasContact?: boolean;
  copyrightYear?: number | null;
};

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
  let res: Response;
  try {
    res = await fetch(target, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PortfolioRank/0.1)" },
    });
  } catch {
    return { ok: false, error: "unreachable" };
  }
  if (!res.ok) return { ok: false, error: `http_${res.status}` };

  const html = (await res.text()).slice(0, 800_000);
  const meta = parseMetaTags(html);
  const finalUrl = res.url || target;
  const host = new URL(finalUrl).hostname;

  const ogImage = meta["og:image"] ?? null;
  let ogImageLoads = false;
  if (ogImage) {
    try {
      const abs = new URL(ogImage, finalUrl).href;
      const img = await fetch(abs, {
        method: "HEAD",
        signal: AbortSignal.timeout(6_000),
      });
      ogImageLoads =
        img.ok &&
        (img.headers.get("content-type")?.startsWith("image/") ?? false);
    } catch {}
  }

  let favicon = /<link\s[^>]*rel=["'][^"']*icon[^"']*["']/i.test(html);
  if (!favicon) {
    try {
      const ico = await fetch(new URL("/favicon.ico", finalUrl).href, {
        method: "HEAD",
        signal: AbortSignal.timeout(5_000),
      });
      favicon = ico.ok;
    } catch {}
  }

  const yearMatch = html.match(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(20\d{2})/i);

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
    hasGithubLink: /href=["'][^"']*github\.com\//i.test(html),
    hasResume: /href=["'][^"']*(resume|\bcv\b)[^"']*["']/i.test(html),
    hasContact:
      /mailto:|href=["'][^"']*contact|<form/i.test(html) ||
      /linkedin\.com\/in\//i.test(html),
    copyrightYear: yearMatch ? Number(yearMatch[1]) : null,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url).searchParams.get("url");
  if (!url || !/^https?:\/\//.test(url)) {
    return NextResponse.json({ ok: false, error: "bad_url" }, { status: 400 });
  }
  const data = await cached<Inspection>(
    "inspect",
    url,
    7 * 24 * 3600 * 1000,
    () => inspect(url)
  );
  return NextResponse.json(data);
}
