// The one definition of "an address we must never reach": used by
// lib/safefetch.ts (every Worker fetch of a portfolio), the grader's address
// check (lib/grader/url.mjs) and the capture job's filtering proxy and
// fetches on GitHub Actions (pipeline/net-guard-node.mjs), where a page could
// otherwise point Chromium at the runner's own network.
//
// Hostnames that must never be fetched. The URL parser has already turned
// decimal, octal and hex IPv4 forms (http://2130706433/) into dotted quads and
// lower-cased the host, so these patterns see the canonical form.
// - names: localhost and *.localhost, *.local (mDNS), *.internal, *.home.arpa;
// - IPv4: 0/8 ("this network", 0.0.0.0 reaches loopback), 10/8, 100.64/10
//   (carrier-grade NAT), 127/8, 169.254/16 (link-local, incl. the cloud
//   metadata endpoint 169.254.169.254), 172.16/12, 192.0.0/24, 192.168/16,
//   198.18/15 (benchmarking), and 224/3 (multicast and reserved); plus
//   168.63.129.16, Azure's WireServer: a public-range address that reaches
//   the host of every Azure VM, GitHub's hosted runners included;
// - IPv6: `::` catches ::1, :: and ::ffff:<v4> (IPv4-mapped, which a redirect
//   could use to smuggle loopback past a v4-only check), fc00::/7 (ULA),
//   fe80::/10 (link-local), ff00::/8 (multicast) and 64:ff9b::/96 (NAT64,
//   which maps onto IPv4 addresses).
export const BLOCKED_HOSTNAME = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)\.?$/;
export const BLOCKED_IPV4 =
  /^(0|10|127|22[4-9]|2[3-5]\d)\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.0\.0\.|^192\.168\.|^198\.1[89]\.|^168\.63\.129\.16$/;
export const BLOCKED_IPV6 = /^(::|f[cd]|fe[89ab]|ff|64:ff9b:)/;

const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * Is this IP address (as DNS returns it: dotted IPv4, or IPv6 without
 * brackets) on the public internet? IPv4-mapped IPv6 is judged as its IPv4.
 */
export function isPublicIp(address) {
  const a = String(address ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (IPV4.test(a)) return !BLOCKED_IPV4.test(a);
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return !BLOCKED_IPV4.test(mapped[1]);
  if (!a.includes(":")) return false;
  // "::" or any address that starts with "::" (loopback, unspecified, mapped forms).
  return !BLOCKED_IPV6.test(a);
}

/**
 * http(s), no credentials, and a host that is neither a blocked name nor a
 * private address literal. A name that resolves to a private address is
 * caught where the request is made: global_fetch_strictly_public on the
 * Worker, the DNS check in pipeline/net-guard-node.mjs on Actions.
 */
export function isPublicHttpUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname;
  if (IPV4.test(host)) return !BLOCKED_IPV4.test(host);
  if (host.startsWith("[")) return !BLOCKED_IPV6.test(host.slice(1, -1));
  return !BLOCKED_HOSTNAME.test(host);
}
