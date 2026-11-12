// Network guards for the grader's capture job on GitHub Actions
// (scripts/grade-jobs.mjs). A visitor chooses the address, and the page at
// it chooses everything it loads, so neither Chromium nor our own fetches
// may reach the runner's private network (the cloud metadata service,
// localhost services, link-local and private ranges; lib/net-guard.mjs).
//
//   createFilteringProxy  a local HTTP proxy every browser request goes
//                         through: it resolves each host itself, refuses
//                         any name that resolves to a private address, and
//                         connects to the very address it checked (so DNS
//                         can't be switched between the check and the
//                         connection); only ports 80 and 443; WebSocket
//                         upgrades refused; bytes counted against a cap
//   guardedFetch          fetch for Node with redirects followed by hand,
//                         every hop's address checked the same way and
//                         pinned for the connection (pinnedLookup)
//   resolvePublic         the DNS check both use
import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { isPublicHttpUrl, isPublicIp } from "../lib/net-guard.mjs";

export const ALLOWED_PORTS = new Set([80, 443]);
/** Marks the proxy's own refusals of plain http requests (a 403 the site didn't send). */
export const BLOCKED_HEADER = "x-grade-proxy-blocked";

/**
 * Resolves `host` and returns { ok: true, address } when every address it
 * resolves to is public, else { ok: false, reason }. An IP literal is
 * checked as is.
 */
export async function resolvePublic(host, { lookup = dns.lookup, allow = isPublicIp } = {}) {
  const h = String(host ?? "").replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!h) return { ok: false, reason: "no host" };
  if (net.isIP(h)) return allow(h) ? { ok: true, address: h } : { ok: false, reason: "private address" };
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/.test(h)) return { ok: false, reason: "local name" };
  let addrs;
  try {
    addrs = await lookup(h, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: "DNS lookup failed" };
  }
  const list = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => (typeof a === "string" ? a : a.address));
  if (!list.length) return { ok: false, reason: "no address" };
  if (!list.every((a) => allow(a))) return { ok: false, reason: "resolves to a private address" };
  return { ok: true, address: list[0] };
}

/**
 * A forward proxy on 127.0.0.1 for Chromium (launch it with this proxy and
 * `--proxy-bypass-list=<-loopback>`, so even localhost goes through it).
 * Returns { port, url, stats, close() }; stats counts { requests, blocked,
 * bytes } and `blocked` lists the hosts refused (for the job's log).
 */
export async function createFilteringProxy({ lookup = dns.lookup, allow = isPublicIp, ports = ALLOWED_PORTS, maxBytes = 60 * 1024 * 1024, timeoutMs = 30000 } = {}) {
  const stats = { requests: 0, blocked: 0, bytes: 0, refusedHosts: new Set(), overBudget: false };
  const check = async (host, port) => {
    if (!ports.has(port)) return { ok: false, reason: `port ${port}` };
    if (stats.bytes > maxBytes) {
      stats.overBudget = true;
      return { ok: false, reason: "page weight cap" };
    }
    return resolvePublic(host, { lookup, allow });
  };
  const refuse = (host) => {
    stats.blocked++;
    if (stats.refusedHosts.size < 20) stats.refusedHosts.add(String(host).slice(0, 100));
  };

  const server = http.createServer(async (req, res) => {
    // Plain http:// requests arrive with an absolute URL.
    stats.requests++;
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const port = Number(target.port || 80);
    const ok = target.protocol === "http:" ? await check(target.hostname, port) : { ok: false };
    if (!ok.ok) {
      refuse(target.hostname);
      res.writeHead(403, { "content-type": "text/plain", [BLOCKED_HEADER]: "1" }).end("blocked");
      return;
    }
    const headers = { ...req.headers, host: target.host };
    delete headers["proxy-connection"];
    const upstream = http.request(
      { host: ok.address, port, method: req.method, path: `${target.pathname}${target.search}`, headers, timeout: timeoutMs },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.on("data", (c) => (stats.bytes += c.length));
        up.pipe(res);
      }
    );
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  // https:// (and anything else tunnelled) arrives as CONNECT host:port.
  server.on("connect", async (req, client, head) => {
    stats.requests++;
    const m = String(req.url ?? "").match(/^\[?([^\]]+?)\]?:(\d+)$/);
    const host = m?.[1] ?? "";
    const port = Number(m?.[2] ?? 0);
    const ok = m ? await check(host, port) : { ok: false };
    if (!ok.ok) {
      refuse(host);
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect({ host: ok.address, port, timeout: timeoutMs }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("data", (c) => (stats.bytes += c.length));
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });

  server.on("upgrade", (req, socket) => {
    refuse(String(req.headers.host ?? ""));
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    stats,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve(undefined));
      }),
  };
}

/**
 * A `lookup` for net.connect and tls.connect that answers only with an
 * address resolvePublic checked, so the connection goes to the very address
 * that passed (a DNS answer that changes between a check and the connection,
 * "DNS rebinding", can't reach the runner's network). Fails with
 * code EBLOCKED otherwise.
 */
export function pinnedLookup({ lookup = dns.lookup, allow = isPublicIp } = {}) {
  return (hostname, options, callback) => {
    resolvePublic(hostname, { lookup, allow }).then(
      (r) => {
        if (!r.ok) return callback(Object.assign(new Error(`blocked: ${r.reason}`), { code: "EBLOCKED" }));
        const family = net.isIP(r.address);
        if (options?.all) callback(null, [{ address: r.address, family }]);
        else callback(null, r.address, family);
      },
      (e) => callback(e)
    );
  };
}

/**
 * fetch for Node that refuses private addresses: redirects are followed by
 * hand, each hop must be http(s) on port 80 or 443 and resolve to public
 * addresses only. Throws "blocked: ..." for a refused hop. Every connection
 * resolves its name through pinnedLookup (an undici Agent's connect
 * lookup), so it connects only to an address that passed the check, like
 * createFilteringProxy does for the browser's traffic. A test may pass its
 * own fetchImpl (no connections) or ports.
 */
export function guardedFetch({ lookup = dns.lookup, allow = isPublicIp, fetchImpl, ports = ALLOWED_PORTS, maxHops = 5 } = {}) {
  if (!fetchImpl) {
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup({ lookup, allow }) } });
    fetchImpl = async (url, init) => {
      try {
        return await undiciFetch(url, { ...init, dispatcher });
      } catch (e) {
        // undici reports "fetch failed" with the lookup's refusal as the cause.
        if (e?.cause?.code === "EBLOCKED") throw new Error(e.cause.message);
        throw e;
      }
    };
  }
  return async (input, init = {}) => {
    let url = String(input?.url ?? input);
    for (let hop = 0; hop <= maxHops; hop++) {
      if (!isPublicHttpUrl(url)) throw new Error("blocked: not a public http(s) address");
      const u = new URL(url);
      const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
      if (!ports.has(port)) throw new Error(`blocked: port ${port}`);
      const r = await resolvePublic(u.hostname, { lookup, allow });
      if (!r.ok) throw new Error(`blocked: ${r.reason}`);
      const res = await fetchImpl(url, { ...init, redirect: "manual" });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        try {
          await res.body?.cancel?.();
        } catch {
          /* nothing to drain */
        }
        url = new URL(res.headers.get("location"), url).href;
        continue;
      }
      return res;
    }
    throw new Error("blocked: too many redirects");
  };
}
