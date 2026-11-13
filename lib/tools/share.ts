import type { CacheMeta } from "@/lib/cache";
import { readCapped } from "@/lib/safefetch";
import { publicFetcher, type Fetcher } from "@/lib/grader/quick";

// The share preview checker (app/api/tools/share-preview): what LinkedIn,
// Slack and X show when someone pastes a portfolio's link, from one capped
// fetch of the page plus one of its share image (lib/safefetch.ts: every
// redirect re-checked against private addresses, bodies capped, timeouts).
// The result is saved under "share:<url>" in the cache table.

export type ShareImage = {
  url: string;
  loads: boolean;
  type?: string | null;
  bytes?: number | null;
  width?: number | null;
  height?: number | null;
};

export type ShareIssue = {
  id: string;
  /** "fix" changes how the card looks; "tip" is a smaller improvement. */
  level: "fix" | "tip";
  title: string;
  tip: string;
};

export type ShareResult = CacheMeta & {
  ok: boolean;
  error?: "unreachable" | "http_error" | "not_html";
  finalUrl?: string;
  /** What the card shows: the platform's fallbacks applied (og:title, else <title>, and so on). */
  card?: { title: string | null; description: string | null; image: ShareImage | null; host: string; siteName: string | null; large: boolean };
  /** The raw tags, for the "what we found" table. */
  tags?: Record<string, string | null>;
  issues?: ShareIssue[];
};

const PAGE_MAX_BYTES = 800_000;
const IMAGE_SNIFF_BYTES = 256_000;

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

/** The page's <meta> tags by property or name (first one wins), lower-cased keys. */
export function metaTags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? "";
    const key = (attrs.property ?? attrs.name)?.toLowerCase();
    if (key && attrs.content !== undefined && !(key in out)) out[key] = decode(attrs.content);
  }
  return out;
}

function linkHref(html: string, rel: RegExp): string | null {
  for (const tag of html.match(/<link\s[^>]*>/gi) ?? []) {
    const r = tag.match(/\brel\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    if (!rel.test(r)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']*)["']/i)?.[1];
    if (href) return decode(href);
  }
  return null;
}

/** Width and height from the first bytes of a PNG, GIF, JPEG or WebP; null when unknown. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const u16be = (i: number) => (b[i] << 8) | b[i + 1];
  const u16le = (i: number) => b[i] | (b[i + 1] << 8);
  const u32be = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: u32be(16), height: u32be(20) };
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: u16le(6), height: u16le(8) };
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === "VP8 ") return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (kind === "VP8L") {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const len = u16be(i + 2);
      // Start-of-frame markers carry the size (C0 to CF, except C4, C8 and CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: u16be(i + 7), height: u16be(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

async function checkImage(url: string, fetcher: Fetcher): Promise<ShareImage> {
  const got = await fetcher(url, { timeoutMs: 8_000 });
  if (!got || !got.res.ok) {
    await got?.res.body?.cancel().catch(() => {});
    return { url, loads: false };
  }
  const type = got.res.headers.get("content-type");
  const declared = Number(got.res.headers.get("content-length") ?? NaN);
  if (!type?.startsWith("image/")) {
    await got.res.body?.cancel().catch(() => {});
    return { url, loads: false, type };
  }
  const head = await readBytes(got.res, IMAGE_SNIFF_BYTES);
  const size = imageSize(head);
  return { url, loads: true, type, bytes: Number.isFinite(declared) ? declared : null, width: size?.width ?? null, height: size?.height ?? null };
}

async function readBytes(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(total, max));
  let at = 0;
  for (const p of parts) {
    const take = Math.min(p.byteLength, out.length - at);
    out.set(p.subarray(0, take), at);
    at += take;
    if (at >= out.length) break;
  }
  return out;
}

/** The issues a card has, biggest first. Pure: the tests call it with plain objects. */
export function shareIssues(tags: Record<string, string | null>, image: ShareImage | null): ShareIssue[] {
  const out: ShareIssue[] = [];
  const title = tags["og:title"] || tags.title;
  const description = tags["og:description"] || tags.description;
  if (!tags["og:image"]) {
    out.push({ id: "no_image", level: "fix", title: "Your link preview has no image", tip: 'Add <meta property="og:image" content="https://yourname.dev/og.png"> with a 1200 x 630 image: a screenshot of your best work or your name on a clean background.' });
  } else if (image && !image.loads) {
    out.push({ id: "image_broken", level: "fix", title: "Your share image doesn't load", tip: "The og:image address answers with an error or isn't an image. Open it in a private window, fix the path, and use a full https:// address." });
  } else if (image?.width && image.height) {
    if (image.width < 600) out.push({ id: "image_small", level: "fix", title: `Your share image is small (${image.width} x ${image.height})`, tip: "LinkedIn and X show a big card only for images at least 600 px wide, and look sharp at 1200 x 630." });
    else if (Math.abs(image.width / image.height - 1.91) > 0.35) out.push({ id: "image_ratio", level: "tip", title: `Your share image will be cropped (${image.width} x ${image.height})`, tip: "Cards are about 1.91 to 1 (1200 x 630). Keep the important part in the middle, or export at that size." });
  }
  if (image?.loads && image.bytes && image.bytes > 5_000_000) out.push({ id: "image_heavy", level: "tip", title: "Your share image is over 5 MB", tip: "Some apps skip images this big. Export it as a JPEG or WebP under 1 MB." });
  if (tags["og:image"] && !/^https?:\/\//i.test(tags["og:image"])) out.push({ id: "image_relative", level: "tip", title: "Your share image uses a relative address", tip: "Some apps can't follow /og.png. Write the full address, https://yourname.dev/og.png." });
  if (!title) out.push({ id: "no_title", level: "fix", title: "Your page has no title", tip: 'Add <title>Jane Doe - Frontend Developer</title>, and the same in og:title.' });
  else {
    if (!tags["og:title"]) out.push({ id: "no_og_title", level: "tip", title: "No og:title", tip: "Apps fall back to your <title>, which usually works; add og:title to choose exactly what the card says." });
    if (title.length > 70) out.push({ id: "title_long", level: "tip", title: `Your title is long (${title.length} characters)`, tip: "Cards cut titles at about 60 to 70 characters. Lead with your name and role." });
  }
  if (!description) out.push({ id: "no_description", level: "fix", title: "Your link preview has no description", tip: 'Add <meta name="description"> and og:description: one sentence on who you are and what you build, about 150 characters.' });
  else if (description.length > 200) out.push({ id: "description_long", level: "tip", title: `Your description is long (${description.length} characters)`, tip: "Most cards show about 150 characters. Put the important part first." });
  if (!tags["twitter:card"]) out.push({ id: "no_twitter_card", level: "tip", title: "X shows a small card", tip: 'Add <meta name="twitter:card" content="summary_large_image"> so X shows your image full width.' });
  if (!tags.icon) out.push({ id: "no_favicon", level: "tip", title: "No favicon", tip: "Add a small icon (<link rel=\"icon\" href=\"/favicon.svg\">). Slack and browser tabs show it next to your name." });
  const order = { fix: 0, tip: 1 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

/** Fetches a page and reads its share card. Never throws. */
export async function checkShare(target: string, { fetcher = publicFetcher }: { fetcher?: Fetcher } = {}): Promise<ShareResult> {
  const got = await fetcher(target, { timeoutMs: 10_000 });
  if (!got) return { ok: false, error: "unreachable" };
  const { res, finalUrl } = got;
  if (res.status >= 400) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, error: "http_error", finalUrl };
  }
  const type = res.headers.get("content-type") ?? "";
  if (type && !/text\/html|application\/xhtml/i.test(type)) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, error: "not_html", finalUrl };
  }
  const html = await readCapped(res, PAGE_MAX_BYTES);
  const meta = metaTags(html);
  const abs = (u: string | null | undefined) => {
    if (!u) return null;
    try {
      return new URL(u, finalUrl).href;
    } catch {
      return null;
    }
  };
  const tags: Record<string, string | null> = {
    title: decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "") || null,
    description: meta.description ?? null,
    "og:title": meta["og:title"] ?? null,
    "og:description": meta["og:description"] ?? null,
    "og:image": meta["og:image"] ?? meta["og:image:url"] ?? meta["og:image:secure_url"] ?? null,
    "og:url": meta["og:url"] ?? null,
    "og:site_name": meta["og:site_name"] ?? null,
    "twitter:card": meta["twitter:card"] ?? null,
    "twitter:image": meta["twitter:image"] ?? null,
    canonical: linkHref(html, /\bcanonical\b/i),
    icon: linkHref(html, /\bicon\b/i),
  };
  const imageUrl = abs(tags["og:image"] ?? tags["twitter:image"]);
  const image = imageUrl ? await checkImage(imageUrl, fetcher) : null;
  const host = new URL(finalUrl).hostname.replace(/^www\./, "");
  return {
    ok: true,
    finalUrl,
    card: {
      title: tags["og:title"] || tags.title,
      description: tags["og:description"] || tags.description,
      image,
      host,
      siteName: tags["og:site_name"],
      large: tags["twitter:card"] === "summary_large_image",
    },
    tags,
    issues: shareIssues(tags, image),
  };
}
