// One spelling per site for the discovery pipeline (docs/DISCOVERY.md):
// every address a source finds goes through normalizeCandidate before the
// seen-check, so the same site found twice (or spelled two ways) is one
// row in discovery_sites.
//
// Built on the grader's normalizeGradeUrl (lib/grader/url.mjs): public
// http(s) hosts only, default ports, no user name, no query or fragment,
// no trailing slash. On top of it: https always, no www, no /index.html,
// and hosts that are a platform rather than someone's own site (GitHub,
// LinkedIn, Notion, link-in-bio pages, big sites) are refused.
import { normalizeGradeUrl, siteKeyOf } from "../../lib/grader/url.mjs";

// Hosts that are never one person's own site, even when a profile or a
// post links them as "my site" (the pilot's lists, merged).
export const PLATFORM_HOST =
  /(^|\.)(github\.com|githubusercontent\.com|gitlab\.com|bitbucket\.org|linkedin\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|threads\.net|bsky\.app|mastodon\.social|youtube\.com|youtu\.be|behance\.net|dribbble\.com|medium\.com|dev\.to|hashnode\.(com|dev)|codepen\.io|codesandbox\.io|stackblitz\.com|replit\.com|figma\.com|notion\.so|notion\.site|google\.com|goo\.gl|npmjs\.com|pypi\.org|t\.me|wa\.me|bit\.ly|linktr\.ee|bio\.link|beacons\.ai|example\.com|ycombinator\.com|wikipedia\.org|reddit\.com|stackoverflow\.com|apple\.com|amazon\.com|amazonaws\.com|imgur\.com|giphy\.com|unsplash\.com|forem\.com|cloudinary\.com|archive\.org|discord\.(gg|com)|producthunt\.com|w3\.org|mozilla\.org|vercel\.com|netlify\.com|cloudflare\.com|heroku\.com|npm\.im|substack\.com|tiktok\.com|twitch\.tv|spotify\.com|forms\.gle|calendly\.com|cal\.com|gumroad\.com|buymeacoffee\.com|ko-fi\.com|patreon\.com|chatgpt\.com|openai\.com|anthropic\.com|claude\.ai|shields\.io|jsfiddle\.net|glitch\.me|daily\.dev|freecodecamp\.org|tailwindcss\.com|react\.dev|reactjs\.org|nextjs\.org|astro\.build|gatsbyjs\.com|threejs\.org|svelte\.dev|vuejs\.org|angular\.io|nytimes\.com|bbc\.co\.uk|arxiv\.org|microsoft\.com|wordpress\.com|wix\.com|squarespace\.com|blogspot\.com|readthedocs\.io|mailchimp\.com|typeform\.com|airtable\.com|ibb\.co|postimg\.cc|loom\.com|vimeo\.com|keybase\.io|angel\.co|wellfound\.com|indeed\.com|upwork\.com|fiverr\.com|leetcode\.com|hackerrank\.com|kaggle\.com|credly\.com|coursera\.org|udemy\.com|docs\.google\.com|drive\.google\.com|dropbox\.com|onedrive\.live\.com|1drv\.ms|read\.cv|polywork\.com|about\.me)$/i;

/**
 * The one spelling of a candidate address, or why it was refused.
 * `root` reduces it to the site's home page (links in posts often point at
 * one article or project of the site).
 * @param {unknown} raw
 * @param {{ root?: boolean }} [options]
 * @returns {{ ok: true, url: string, key: string, host: string } | { ok: false, reason: string }}
 */
export function normalizeCandidate(raw, { root = false } = {}) {
  let s = String(raw ?? "")
    .trim()
    .replace(/[.,;:!?*_`'")\]}>]+$/, "");
  if (!s) return { ok: false, reason: "empty" };
  if (/^\/\//.test(s)) s = `https:${s}`;
  const n = normalizeGradeUrl(s);
  if (!n.ok) return { ok: false, reason: n.error };
  const u = new URL(n.url);
  u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  if (PLATFORM_HOST.test(u.hostname)) return { ok: false, reason: "platform" };
  u.pathname = root ? "/" : u.pathname.replace(/\/index\.html?$/i, "").replace(/\/+$/, "") || "/";
  const url = u.pathname === "/" ? `${u.origin}/` : u.href;
  return { ok: true, url, key: siteKeyOf(url), host: u.hostname };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** HTML entities decoded (Hacker News and many pages escape text). */
export function decodeEntities(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      try {
        return String.fromCodePoint(n);
      } catch {
        return "";
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Every http(s) link in a piece of text or HTML, in order, without duplicates. */
export function extractLinks(text) {
  const out = [];
  for (const m of decodeEntities(text).matchAll(/https?:\/\/[^\s"'<>()[\]{}|\\^`]+/gi)) {
    const link = m[0].replace(/[.,;:!?*_`]+$/, "");
    if (!out.includes(link)) out.push(link);
  }
  return out;
}
