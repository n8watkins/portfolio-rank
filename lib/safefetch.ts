// Guards for fetching attacker-influenced URLs (portfolio sites we inspect).
// Even roster URLs are third-party servers: their owner controls redirects and
// response size, so a naive fetch is an SSRF + memory-exhaustion primitive.

// Hostnames that must never be fetched: loopback, link-local (incl. the cloud
// metadata endpoint 169.254.169.254), and RFC1918 / unique-local IP literals.
// IPv6 forms covered: `\[?::` catches ::1 (loopback), :: (unspecified), and
// crucially ::ffff:<v4> (IPv4-mapped — e.g. [::ffff:127.0.0.1], which a redirect
// could use to smuggle loopback past a v4-only check); `f[cd]` = ULA (fc00::/7);
// `fe[89ab]` = link-local (fe80::/10).
const BLOCKED_HOST =
  /^(localhost|.*\.local|0\.0\.0\.0|127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::|\[?f[cd]|\[?fe[89ab])/i;

function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return !BLOCKED_HOST.test(u.hostname);
}

/**
 * Fetch following redirects ourselves, re-checking every hop against the
 * private-address blocklist (a roster site can 302 to an internal address —
 * `redirect: "follow"` would chase it). Returns the final Response (body
 * undrained) and its resolved URL, or null if blocked/unreachable.
 */
export async function safeFetch(
  startUrl: string,
  init: { method?: string; timeoutMs: number; maxHops?: number } = {
    timeoutMs: 10_000,
  }
): Promise<{ res: Response; finalUrl: string } | null> {
  const maxHops = init.maxHops ?? 5;
  let url = startUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    if (!isPublicHttpUrl(url)) return null;
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(init.timeoutMs),
        // A real browser UA — some sites serve a block page or 403 to obviously
        // non-browser agents, which showed up as "unreachable" in the checks.
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        },
      });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { res, finalUrl: url };
      url = new URL(loc, url).href; // resolve relative redirects, re-check next loop
      continue;
    }
    return { res, finalUrl: res.url || url };
  }
  return null; // too many redirects
}

/**
 * Read a response body as text, but never buffer more than `maxBytes` — a
 * hostile server can stream gigabytes within the timeout, and slicing after
 * `res.text()` is too late. Reads incrementally and stops at the budget.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (total >= maxBytes) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out;
}
