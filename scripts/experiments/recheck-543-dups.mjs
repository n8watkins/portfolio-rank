#!/usr/bin/env node
// Duplicates in recheck-543 (owner rule, 2026-11-13): one site under several
// addresses. Two kinds:
//   - the same address written differently (a trailing slash, "www.", http);
//   - the same page text on different hosts (a copy, or a platform address
//     and a custom domain for the same site).
// Which address to keep, in order: the one the others redirect to; else a
// custom domain over a platform address (vercel.app, github.io, netlify.app
// and the like); else the one on the live list (data/feed.json); else the
// shortest. The others are "duplicate of <keep>": no owner review, nothing
// applied; the kept address goes through the normal flow.
//
// Reads RECHECK_DIR (selection.json, dups.json: the text index over every
// stored page at selection time, the fresh capture meta) and data/feed.json.
// Writes RECHECK_DIR/duplicates.json: { groups, byId, counts }. Redirects are
// checked with a plain request from this machine (no browser, no AI).
//
//   node scripts/experiments/recheck-543-dups.mjs
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readJson, writeJson } from "./grading-two-sets-lib.mjs";
import { DIR, SET } from "./recheck-543.mjs";

const PLATFORM = /(^|\.)(vercel\.app|github\.io|netlify\.app|pages\.dev|onrender\.com|web\.app|firebaseapp\.com|herokuapp\.com|railway\.app|glitch\.me|surge\.sh|gitlab\.io|streamlit\.app|pythonanywhere\.com|framer\.website|webflow\.io|wixsite\.com|carrd\.co|super\.site|notion\.site|is-a\.dev)$/i;
const MIN_WORDS = 20;
// An error or placeholder page from a host (GitHub's "Site not found", a 404): the same text on
// many hosts there means many dead sites, not one site under several addresses.
const ERROR_PAGE = /site not found|there isn.t a github pages site here|\b404\b|page not found|deployment not found|deployment has been disabled|this site can.t be reached|application error|domain (is )?(parked|for sale)/i;

/** The address with its spelling normalised: host lower case without "www.", no trailing slash, no scheme. */
export function addressKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return String(url).toLowerCase();
  }
}
const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};
export const isPlatform = (url) => PLATFORM.test(hostOf(url));
const normalise = (t) => String(t ?? "").toLowerCase().normalize("NFKD").replace(/[^\p{L}]+/gu, " ").trim();
const words = (t) => (t ? t.split(" ").length : 0);
const hashOf = (t) => crypto.createHash("sha1").update(normalise(t)).digest("hex");

/** Where a URL ends up after redirects (a plain GET from here), or null. */
async function finalUrl(url) {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "user-agent": "Mozilla/5.0 PortfolioRank-recheck" } });
    await res.body?.cancel().catch(() => {});
    return res.url || null;
  } catch {
    return null;
  }
}

/**
 * Which member of a group to keep. `members`: [{ url, final, onFeed }].
 * Pure: the redirect target, then a custom domain, then the live list, then the shortest.
 */
export function pickKeep(members) {
  const keys = new Map(members.map((m) => [addressKey(m.url), m]));
  // A member another one redirects to. Only a redirect to a different address counts: a
  // trailing slash or "www." added to the same address is the same address.
  const targets = members
    .filter((m) => m.final && addressKey(m.final) !== addressKey(m.url))
    .map((m) => keys.get(addressKey(m.final)))
    .filter(Boolean);
  if (targets.length) {
    const most = [...new Set(targets)].sort((a, b) => targets.filter((t) => t === b).length - targets.filter((t) => t === a).length)[0];
    return { keep: most, why: "the others redirect to it" };
  }
  const custom = members.filter((m) => !isPlatform(m.url));
  if (custom.length === 1) return { keep: custom[0], why: "its own domain, not a platform address" };
  const pool = custom.length ? custom : members;
  const onFeed = pool.filter((m) => m.onFeed);
  const pick = (onFeed.length ? onFeed : pool).slice().sort((a, b) => a.url.length - b.url.length || a.url.localeCompare(b.url))[0];
  return { keep: pick, why: onFeed.length ? "on the live list" : "the shortest address" };
}

async function main() {
  const sel = readJson(path.join(DIR, "selection.json"));
  const feed = readJson(path.join(import.meta.dirname, "..", "..", "data", "feed.json"));
  const feedKeys = new Set(feed.map((p) => addressKey(p.url)));
  const meta = (id) => {
    const p = path.join(DIR, "bundles", SET, id, "meta.json");
    return fs.existsSync(p) ? readJson(p) : null;
  };
  const sites = sel.sites.map((s) => ({ ...s, page_text: meta(s.id)?.page_text ?? "" }));

  // 1. The same address written differently, within the 543 and within the live list.
  const byKey = new Map();
  for (const s of sites) byKey.set(addressKey(s.url), [...(byKey.get(addressKey(s.url)) ?? []), s]);
  const spelling543 = [...byKey.values()].filter((g) => g.length > 1);
  const feedByKey = new Map();
  for (const p of feed) feedByKey.set(addressKey(p.url), (feedByKey.get(addressKey(p.url)) ?? 0) + 1);
  const spellingFeed = [...feedByKey.values()].filter((n) => n > 1).length;

  // 2. The same page text on different hosts: the fresh captures of the 543, and the stored text of every portfolio.
  const byHash = new Map();
  for (const s of sites) {
    const n = normalise(s.page_text);
    if (words(n) < MIN_WORDS || ERROR_PAGE.test(s.page_text)) continue;
    byHash.set(hashOf(s.page_text), [...(byHash.get(hashOf(s.page_text)) ?? []), s]);
  }
  const text543 = [...byHash.values()].filter((g) => new Set(g.map((s) => hostOf(s.url))).size > 1);
  const index = fs.existsSync(path.join(DIR, "dups.json")) ? readJson(path.join(DIR, "dups.json")) : {};
  const textAll = Object.values(index).filter((hosts) => hosts.length > 1);
  const feedHosts = new Set(feed.map((p) => hostOf(p.url)));
  const textFeed = textAll.filter((hosts) => hosts.filter((h) => feedHosts.has(h)).length > 1);

  // Groups within the 543 (both kinds, merged when they share a site), each with a keep.
  const parent = new Map(sites.map((s) => [s.id, s.id]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  for (const g of [...spelling543, ...text543]) for (const s of g.slice(1)) parent.set(find(s.id), find(g[0].id));
  const groupsById = new Map();
  for (const s of sites) if ([...spelling543, ...text543].some((g) => g.includes(s))) groupsById.set(find(s.id), [...(groupsById.get(find(s.id)) ?? []), s]);
  const groups = [];
  for (const g of groupsById.values()) {
    const members = [];
    for (const s of g) members.push({ id: s.id, url: s.url, group: s.group, final: await finalUrl(s.url), onFeed: feedKeys.has(addressKey(s.url)) });
    const { keep, why } = pickKeep(members);
    groups.push({ keep: keep.url, keepId: keep.id, why, kind: g.every((s) => addressKey(s.url) === addressKey(g[0].url)) ? "spelling" : "same text", members });
  }
  const byId = {};
  for (const g of groups) for (const m of g.members) if (m.id !== g.keepId) byId[m.id] = { duplicateOf: g.keep, keepId: g.keepId, why: g.why, kind: g.kind };
  const counts = {
    groups_in_543: groups.length,
    duplicate_rows_in_543: Object.keys(byId).length,
    spelling_groups_in_543: spelling543.length,
    same_text_groups_in_543: text543.length,
    spelling_duplicates_on_live_list: spellingFeed,
    same_text_groups_all_portfolios: textAll.length,
    same_text_groups_on_live_list: textFeed.length,
  };
  writeJson(path.join(DIR, "duplicates.json"), { at: new Date().toISOString(), counts, groups, byId, textFeed });
  console.log(JSON.stringify(counts, null, 1));
  for (const g of groups) console.log(`keep ${g.keep} (${g.why}); duplicates: ${g.members.filter((m) => m.id !== g.keepId).map((m) => m.url).join(", ")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
