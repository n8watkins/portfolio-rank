// The address a visitor asks to grade: what is accepted, and the one
// normalized form every cap, cache and cooldown keys on.
//
// Accepted: http or https (https is assumed when the scheme is missing), the
// default ports only (80 and 443), no user name or password, a public host
// name with a dot (never an IP literal, a local name or a private range;
// lib/net-guard.mjs), at most URL_MAX characters. The query and the fragment
// are dropped, so "?x=1" can't make a new address for the caches, the caps
// or the re-grade cooldown.
import { isPublicHttpUrl } from "../net-guard.mjs";

export const URL_MAX = 500;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Validates and normalizes a submitted address. Returns
 * { ok: true, url, siteKey, host } or { ok: false, error, message }.
 * @param {unknown} input
 * @returns {{ ok: true, url: string, siteKey: string, host: string } | { ok: false, error: string, message: string }}
 */
export function normalizeGradeUrl(input) {
  /** @type {(error: string, message: string) => { ok: false, error: string, message: string }} */
  const bad = (error, message) => ({ ok: false, error, message });
  let raw = String(input ?? "").trim();
  if (!raw) return bad("url_required", "Paste your portfolio's address, like yourname.dev.");
  if (raw.length > URL_MAX) return bad("url_too_long", `Addresses are at most ${URL_MAX} characters.`);
  if (/\s/.test(raw)) return bad("bad_url", "That doesn't look like a web address.");
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return bad("bad_url", "That doesn't look like a web address.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return bad("bad_scheme", "Only http and https addresses can be graded.");
  if (u.username || u.password) return bad("bad_url", "Addresses with a user name or password can't be graded.");
  if (u.port && u.port !== "80" && u.port !== "443") return bad("bad_port", "Only the standard web ports (80 and 443) can be graded.");
  const host = u.hostname.replace(/\.$/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) return bad("ip_address", "Use the site's name, not an IP address.");
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !/^[a-z]{2,63}$|^xn--[a-z0-9-]+$/.test(labels.at(-1))) {
    return bad("bad_host", "That doesn't look like a public web address.");
  }
  u.hostname = host;
  u.hash = "";
  u.search = "";
  if (!isPublicHttpUrl(u.href)) return bad("private_address", "Only public websites can be graded.");
  // The default port is dropped by the URL parser for the matching scheme;
  // https on :80 or http on :443 stays as typed.
  const path = u.pathname.replace(/\/+$/, "") || "/";
  u.pathname = path;
  return { ok: /** @type {const} */ (true), url: u.href, siteKey: siteKeyOf(u), host: host.replace(/^www\./, "") };
}

/** One key per site address: host without www, path without the trailing slash, scheme ignored. */
export function siteKeyOf(u) {
  const url = typeof u === "string" ? new URL(u) : u;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "").toLowerCase();
  return `${host}${path}`;
}
