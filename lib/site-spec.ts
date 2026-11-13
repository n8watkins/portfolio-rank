// What a portfolio is built with and how, read from the one page fetch the
// polish checks already make (app/api/inspect): the response headers and
// the HTML. No extra request. Each field is left out when the page doesn't
// say, so the games show only what is known.

export type SiteSpec = {
  /** "Next.js", "Astro", "Plain HTML", ... */
  framework?: string;
  /** "Vercel", "Netlify", "GitHub Pages", "Cloudflare", ... */
  host?: string;
  /** Size of the HTML document, in bytes (capped at what we read). */
  htmlBytes?: number;
  /** A responsive viewport meta tag. */
  viewport?: boolean;
  /** Dark mode: a prefers-color-scheme: dark rule in the page's own CSS, or a color-scheme meta with dark. Only ever true. */
  darkMode?: true;
  /** A link to a blog (its own /blog, or Medium, dev.to, Hashnode, Substack). Only ever true. */
  blog?: true;
  /** The HTTP Last-Modified header, as ISO 8601. */
  lastModified?: string;
};

type Headers = { get(name: string): string | null };

const FRAMEWORKS: [string, RegExp][] = [
  ["Next.js", /__NEXT_DATA__|\/_next\/static\//],
  ["Nuxt", /__NUXT__|\/_nuxt\//],
  ["Gatsby", /id="___gatsby"|\/page-data\/app-data\.json/],
  ["Astro", /<astro-island|data-astro-cid|\/_astro\//],
  ["SvelteKit", /\/_app\/immutable\/|data-sveltekit/],
  ["Remix", /__remixContext|__remixManifest/],
  ["Docusaurus", /docusaurus/i],
  ["Framer", /framerusercontent\.com|data-framer-/],
  ["Webflow", /data-wf-page|webflow\.js/],
  ["Wix", /static\.wixstatic\.com|wix-bolt/],
  ["Squarespace", /static1\.squarespace\.com/],
  ["WordPress", /\/wp-content\/|\/wp-includes\//],
  ["Angular", /ng-version=/],
  ["Vue", /data-v-app|data-v-[0-9a-f]{8}|__VUE__/],
  ["Gatsby", /gatsby/i],
];
const GENERATOR: [string, RegExp][] = [
  ["Hugo", /hugo/i],
  ["Jekyll", /jekyll/i],
  ["Hexo", /hexo/i],
  ["Eleventy", /eleventy/i],
  ["Astro", /astro/i],
  ["Gatsby", /gatsby/i],
  ["WordPress", /wordpress/i],
  ["Docusaurus", /docusaurus/i],
  ["Next.js", /next\.js/i],
];

function framework(html: string): string | undefined {
  const gen = html.match(/<meta[^>]+name=["']generator["'][^>]*content=["']([^"']+)["']/i)?.[1] ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']generator["']/i)?.[1];
  if (gen) for (const [name, re] of GENERATOR) if (re.test(gen)) return name;
  for (const [name, re] of FRAMEWORKS) if (re.test(html)) return name;
  // A Vite build (React, Vue, Svelte or plain) leaves hashed /assets/index-*.js.
  if (/\/assets\/index-[\w-]+\.js/.test(html)) return /id=["']root["']/.test(html) ? "React (Vite)" : "Vite";
  if (/id=["']root["']/.test(html) && /<script[^>]+src=/i.test(html)) return "React";
  if (!/<script[^>]+src=/i.test(html)) return "Plain HTML";
  return undefined;
}

function host(headers: Headers, hostname: string): string | undefined {
  const server = (headers.get("server") ?? "").toLowerCase();
  if (headers.get("x-vercel-id") || server === "vercel" || hostname.endsWith(".vercel.app")) return "Vercel";
  if (headers.get("x-nf-request-id") || server.startsWith("netlify") || hostname.endsWith(".netlify.app")) return "Netlify";
  if (hostname.endsWith(".github.io") || server === "github.com") return "GitHub Pages";
  if (hostname.endsWith(".pages.dev")) return "Cloudflare Pages";
  if (hostname.endsWith(".web.app") || hostname.endsWith(".firebaseapp.com")) return "Firebase";
  if (hostname.endsWith(".onrender.com") || headers.get("rndr-id")) return "Render";
  if (hostname.endsWith(".framer.website") || hostname.endsWith(".framer.app")) return "Framer";
  if (headers.get("x-amz-cf-id") || server.includes("amazons3")) return "AWS";
  if (headers.get("cf-ray") || server === "cloudflare") return "Cloudflare";
  return undefined;
}

export function siteSpec(html: string, headers: Headers, finalUrl: string): SiteSpec {
  const hostname = new URL(finalUrl).hostname;
  const spec: SiteSpec = {};
  const f = framework(html);
  if (f) spec.framework = f;
  const h = host(headers, hostname);
  if (h) spec.host = h;
  spec.htmlBytes = new TextEncoder().encode(html).length;
  spec.viewport = /<meta[^>]+name=["']viewport["'][^>]*width=device-width/i.test(html) || /<meta[^>]+content=["'][^"']*width=device-width[^"']*["'][^>]*name=["']viewport["']/i.test(html);
  if (/prefers-color-scheme\s*:\s*dark/i.test(html) || /<meta[^>]+name=["']color-scheme["'][^>]*content=["'][^"']*dark/i.test(html)) spec.darkMode = true;
  if (/href=["'][^"']*(\/blog\b|\/posts?\/|medium\.com\/|dev\.to\/|hashnode\.|substack\.com)/i.test(html)) spec.blog = true;
  const lm = Date.parse(headers.get("last-modified") ?? "");
  if (Number.isFinite(lm)) spec.lastModified = new Date(lm).toISOString();
  return spec;
}
