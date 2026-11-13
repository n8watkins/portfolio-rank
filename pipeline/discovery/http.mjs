// HTTP for the discovery sources: JSON and text from public APIs (GitHub,
// Hacker News Algolia, raw.githubusercontent.com), paced per host, with a
// few retries for rate limits and busy servers. A request that still fails
// throws, so the source stops and its watermark stays where it was.

export const USER_AGENT = "PortfolioRankBot/1.0 (+https://portfoliorank.dev)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A client with one pace per host: `gaps` maps a host to the least time
 * between two requests to it (ms).
 * @param {{ fetchImpl?: typeof fetch, gaps?: Record<string, number>, retries?: number, headers?: (url: URL) => Record<string, string>, wait?: (ms: number) => Promise<void> }} [o]
 */
export function createHttp({ fetchImpl = globalThis.fetch, gaps = {}, retries = 3, headers = () => ({}), wait = sleep } = {}) {
  const next = new Map();
  const counts = {};
  async function pace(host) {
    const gap = gaps[host] ?? 0;
    const at = Math.max(Date.now(), next.get(host) ?? 0);
    next.set(host, at + gap);
    if (at > Date.now()) await wait(at - Date.now());
  }
  async function request(url, { accept = "application/json", allow404 = false } = {}) {
    const u = new URL(url);
    for (let attempt = 0; ; attempt++) {
      await pace(u.host);
      counts[u.host] = (counts[u.host] ?? 0) + 1;
      let res;
      try {
        res = await fetchImpl(u.href, { headers: { "user-agent": USER_AGENT, accept, ...headers(u) }, signal: AbortSignal.timeout(30000) });
      } catch (e) {
        if (attempt < retries) {
          await wait(5000 * (attempt + 1));
          continue;
        }
        throw new Error(`${u.host}: ${String(e?.message ?? e).slice(0, 120)}`);
      }
      if (res.status === 404 && allow404) return null;
      const limited = res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
      if ((limited || res.status >= 500) && attempt < retries) {
        const reset = Number(res.headers.get("retry-after")) * 1000 || Math.max(0, Number(res.headers.get("x-ratelimit-reset")) * 1000 - Date.now()) || 0;
        await wait(Math.min(Math.max(reset, 10000 * (attempt + 1)), 120000));
        continue;
      }
      if (!res.ok) throw new Error(`${u.host} ${u.pathname}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
      return res;
    }
  }
  return {
    counts,
    async json(url, o) {
      const res = await request(url, o);
      return res ? res.json() : null;
    },
    async text(url, o) {
      const res = await request(url, { accept: "text/plain,*/*", ...o });
      return res ? res.text() : null;
    },
  };
}

/** Runs `fn` over `items`, at most `n` at once, keeping the order of the results. */
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const j = i++;
        out[j] = await fn(items[j], j);
      }
    })
  );
  return out;
}
