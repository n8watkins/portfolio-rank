// Proving you own a portfolio with code you deploy (owner, 2026-11-13: "100%
// certain", like Google's site verification), while "Add your portfolio" is
// on (TOOLS_ENABLED; POST /api/owner/verify). The claim gets a random token,
// and the owner puts it on the site one of two ways:
//
//   file  /portfoliorank-<token>.txt at the site root, containing the token
//         (the root, not /.well-known: GitHub Pages drops dot-folders)
//   meta  <meta name="portfoliorank-verification" content="<token>"> on the
//         home page
//
// Only someone who can deploy to the site can do either. The check runs only
// when the owner presses Verify: one fetch, VERIFY_TIMEOUT_MS, at most
// MAX_REDIRECTS redirects and every hop on the same site (www or not), and at
// most VERIFY_TRIES_PER_HOUR tries an hour per account.
//
// A GitHub account whose site is <login>.github.io (or a project page under
// it) is the owner by GitHub's own word, so it is verified at once with no
// fetch (lib/games/claims.mjs pagesAccount).
//
// Plain functions over fetched text, so the tests need no network.

import { hostOf } from "../games/claims.mjs";

export const VERIFICATION_META = "portfoliorank-verification";
export const VERIFY_TIMEOUT_MS = 5000;
export const MAX_REDIRECTS = 3;
export const VERIFY_TRIES_PER_HOUR = 5;
/** The most of a verification file or home page read. */
export const FILE_MAX_BYTES = 4096;
export const PAGE_MAX_BYTES = 512 * 1024;

/** Tokens are URL- and file-name-safe: letters, digits, "-" and "_". */
export const TOKEN_RE = /^[A-Za-z0-9_-]{12,64}$/;

/** The verification file's path for a token. */
export function verificationPath(token) {
  if (!TOKEN_RE.test(String(token ?? ""))) throw new Error("bad verification token");
  return `/portfoliorank-${token}.txt`;
}

/** The verification file's full address on the site (its root, whatever path the portfolio is listed under). */
export function verificationFileUrl(siteUrl, token) {
  const u = new URL(siteUrl);
  return `${u.origin}${verificationPath(token)}`;
}

/** The meta tag to paste into the home page's <head>. */
export const verificationTag = (token) => `<meta name="${VERIFICATION_META}" content="${token}">`;

/** Same site: the same host, "www." or not. */
export function sameSite(a, b) {
  const x = hostOf(a);
  return Boolean(x) && x === hostOf(b);
}

/** True when the file's text is the token (surrounding whitespace and a trailing newline allowed). */
export function fileHasToken(text, token) {
  return TOKEN_RE.test(String(token ?? "")) && String(text ?? "").trim() === token;
}

/** The content of every <meta name="portfoliorank-verification"> tag, in either attribute order. */
export function verificationTokens(html) {
  const out = [];
  for (const m of String(html ?? "").matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const name = tag.match(/\bname\s*=\s*["']?([^"'\s>]+)/i)?.[1];
    if (name?.toLowerCase() !== VERIFICATION_META) continue;
    const content = tag.match(/\bcontent\s*=\s*["']?([^"'\s>]+)/i)?.[1];
    if (content) out.push(content);
  }
  return out;
}

/**
 * Follows at most `maxRedirects` redirects by hand, every hop on the same
 * site as `url`. `hop(url)` makes one request without following redirects
 * and returns a Response. Returns { ok: true, status, text, finalUrl } or
 * { ok: false, error } with error "too_many_redirects", "off_site",
 * "unreachable" or "timeout".
 * @param {string} url
 * @param {{ hop: (url: string) => Promise<Response>, maxRedirects?: number, maxBytes?: number }} options
 */
export async function fetchSameSite(url, { hop, maxRedirects = MAX_REDIRECTS, maxBytes = PAGE_MAX_BYTES }) {
  let at = url;
  for (let i = 0; i <= maxRedirects; i++) {
    let res;
    try {
      res = await hop(at);
    } catch (e) {
      return { ok: false, error: /timeout|abort/i.test(String(e?.name ?? e)) ? "timeout" : "unreachable" };
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel().catch(() => {});
      const next = new URL(String(res.headers.get("location")), at).href;
      if (!/^https?:$/.test(new URL(next).protocol) || !sameSite(next, url)) return { ok: false, error: "off_site" };
      at = next;
      continue;
    }
    return { ok: true, status: res.status, text: await readText(res, maxBytes), finalUrl: at, type: res.headers.get("content-type") ?? "" };
  }
  return { ok: false, error: "too_many_redirects" };
}

async function readText(res, maxBytes) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const all = new Uint8Array(Math.min(size, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, all.length - off);
    all.set(c.subarray(0, take), off);
    off += take;
    if (off >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

/**
 * Checks one proof with one fetch. `method` "file" fetches the verification
 * file at the site root; "meta" the listed address's home page. Returns
 * { ok: true } or { ok: false, reason } with reason "not_found" (the file or
 * tag isn't there, or holds another token), "off_site", "too_many_redirects",
 * "unreachable" or "timeout".
 * @param {{ url: string, token: string, method: "file" | "meta", hop: (url: string) => Promise<Response> }} args
 */
export async function checkProof({ url, token, method, hop }) {
  const target = method === "file" ? verificationFileUrl(url, token) : url;
  const got = await fetchSameSite(target, { hop, maxBytes: method === "file" ? FILE_MAX_BYTES : PAGE_MAX_BYTES });
  if (!got.ok) return { ok: false, reason: got.error };
  if (got.status !== 200) return { ok: false, reason: "not_found" };
  const ok = method === "file" ? fileHasToken(got.text, token) : verificationTokens(got.text).includes(token);
  return ok ? { ok: true } : { ok: false, reason: "not_found" };
}
