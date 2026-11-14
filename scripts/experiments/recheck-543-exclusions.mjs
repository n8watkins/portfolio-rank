#!/usr/bin/env node
// The recheck-543 verdicts kept on file (owner, 2026-11-13): entries for
// data/excluded.json, so these sites are never captured or graded again.
//   not_portfolio  both graders said no (and it is not a broken page), a code
//                  rule settled it, or the owner decided it (his 6 verdicts on
//                  the disagreements and his 22 rejections on /admin/review)
//   dead           the name does not resolve (from GitHub and from the owner's
//                  machine), or a 404 or broken deploy among the both-no; a
//                  check every few months (recheck_after), not a permanent ban
//   duplicate      another address of a site kept under one address
//                  (duplicate_of)
// A site the owner confirmed as a portfolio is never excluded.
//
// Reads RECHECK_DIR (selection.json, results.json, ungraded.json,
// duplicates.json) and a JSON-lines export of the decided review rows
// (queue-export); writes RECHECK_DIR/exclusions.json.
//
//   node scripts/experiments/recheck-543-exclusions.mjs <decided.jsonl>
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readJson, writeJson } from "./grading-two-sets-lib.mjs";
import { DIR, PROMPT_VERSION } from "./recheck-543.mjs";

export const DAY = "2026-11-13";
export const RECHECK_AFTER = "2027-02-13";
// A 404, a broken or paused deploy, an error screen: dead, not a judgement on the portfolio.
const BROKEN = /\b404\b|not found|broken|error page|deployment|server error|does not load|paused|site not found|loading screen for a web hosting/i;

/** The address in one form: lower-case scheme and host, no fragment, no trailing slash. */
export function normalUrl(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.hostname.toLowerCase()}${u.port ? `:${u.port}` : ""}${p}${u.search}`;
  } catch {
    return String(url).trim();
  }
}

/** The key the list's readers match on (generate_feed.py norm_key): lower case, no "www.", no trailing slash, no scheme. */
export function readerKey(url) {
  try {
    const u = new URL(String(url).trim().toLowerCase());
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return String(url).trim().toLowerCase();
  }
}

const short = (s, n = 140) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** The entries, keyed by normalized URL (the first reason wins, in the order the kinds are listed above). */
export function buildEntries({ sites, results, ungraded, duplicates, decided }) {
  const name = new Map(sites.map((s) => [s.url, s.name || s.url]));
  const byUrl = new Map(results.map((r) => [r.url, r]));
  // Matched the way the list's readers match (readerKey), so no spelling of a site the owner
  // confirmed as a portfolio is ever excluded, and one site gets one entry.
  const confirmedPortfolio = new Set(decided.filter((d) => d.status === "confirmed" && d.proposed === "relist").map((d) => readerKey(d.url)));
  const out = new Map();
  const add = (url, e) => {
    const key = readerKey(url);
    if (confirmedPortfolio.has(key) || out.has(key)) return;
    out.set(key, { url: normalUrl(url), name: name.get(url) ?? url, removed: DAY, ...e });
  };
  const evidence = (r) => ({
    prompt: PROMPT_VERSION,
    gemini31: r?.verdicts?.gemini31?.batch?.reason ?? null,
    haiku: r?.verdicts?.haiku?.batch?.reason ?? null,
  });
  // The owner's verdicts and rejections.
  for (const d of decided) {
    const owner = d.status === "confirmed" && d.proposed === "remove" && String(d.decided_by).startsWith("owner:");
    const rejected = d.status === "rejected" && !String(d.decided_by).startsWith("rule:");
    if (!owner && !rejected) continue;
    add(d.url, { kind: "not_portfolio", reason: "Not a portfolio, decided by the owner on review", decided_by: "owner", evidence: { ...evidence(byUrl.get(d.url)), review: short(d.reason, 300) } });
  }
  // Code rules and both-model "no".
  for (const r of results) {
    if (r.path === "code_rule") add(r.url, { kind: "not_portfolio", reason: `Not a portfolio: ${r.junk}`, decided_by: `code:${r.junk}`, evidence: { rule: r.junk } });
    if (r.path === "graders" && r.outcome === "not_portfolio" && !r.owner) {
      const reasons = `${r.verdicts.gemini31.batch?.reason ?? ""} ${r.verdicts.haiku.batch?.reason ?? ""}`;
      if (BROKEN.test(reasons)) add(r.url, { kind: "dead", reason: "A broken page (a 404 or a failed deploy) on the re-check", decided_by: "ai:gemini-3.1+haiku-5.5", recheck_after: RECHECK_AFTER, evidence: evidence(r) });
      else add(r.url, { kind: "not_portfolio", reason: "Two AI graders agreed it is not a portfolio on the re-check", decided_by: "ai:gemini-3.1+haiku-5.5", evidence: evidence(r) });
    }
  }
  // Names that do not resolve, from two networks.
  for (const u of ungraded) {
    if (u.kind !== "DNS: name does not resolve") continue;
    add(u.url, { kind: "dead", reason: "The domain no longer resolves", decided_by: "health:dns", recheck_after: RECHECK_AFTER, evidence: { error: "ERR_NAME_NOT_RESOLVED from GitHub Actions and from the owner's machine" } });
  }
  // Duplicates at a different address only. A spelling variant (a trailing slash, "www.") is the
  // same key for every reader (generate_feed.py norm_key, health.mjs normKey): excluding it would
  // exclude the kept site.
  for (const [id, d] of Object.entries(duplicates.byId ?? {})) {
    const s = sites.find((x) => x.id === id);
    if (!s || readerKey(s.url) === readerKey(d.duplicateOf)) continue;
    add(s.url, { kind: "duplicate", reason: `Duplicate of ${normalUrl(d.duplicateOf)}`, duplicate_of: normalUrl(d.duplicateOf), decided_by: "rule:duplicate", evidence: { why: d.why } });
  }
  return [...out.values()];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const decided = fs.readFileSync(process.argv[2], "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const entries = buildEntries({
    sites: readJson(path.join(DIR, "selection.json")).sites,
    results: readJson(path.join(DIR, "results.json")),
    ungraded: readJson(path.join(DIR, "ungraded.json")),
    duplicates: readJson(path.join(DIR, "duplicates.json")),
    decided,
  });
  writeJson(path.join(DIR, "exclusions.json"), entries);
  const by = {};
  for (const e of entries) by[`${e.kind} (${e.decided_by.split(":")[0]})`] = (by[`${e.kind} (${e.decided_by.split(":")[0]})`] ?? 0) + 1;
  console.log(`${entries.length} entries`, JSON.stringify(by, null, 1));
}
