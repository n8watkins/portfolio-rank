// Imports the discovery pilot of 2026-11-12 (~/research/portfoliorank-discovery)
// into the seen-set, once, so the pipeline never checks those sites again
// (docs/DISCOVERY.md "The pilot").
//
//   node scripts/discovery-import.mjs <pilot folder> [--dry-run]
//
// With TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (the staging pair first), or
// LOCAL_DB_FILE. Safe to repeat: rows already in discovery_sites are left
// alone.
//
// What each pilot site becomes, under the table's privacy rules
// (lib/discovery/sites.mjs):
//   - failed the code checks or the filter: `dropped` with the coarse
//     reason; dead, blocked, parked and empty keep the address and get a
//     recheck date counted from the pilot; anything else keeps only the
//     hash, the reason and the dates;
//   - passed both (the 3,620 "kept"): `screen`, with the pilot's evidence
//     (title, description, headings, 1,200 characters, link counts) as
//     their working data, so the AI screen needs no new fetch;
//   - the 1,690 GitHub rows that did not fit the pilot's cap: `found`, with
//     their repo, so the next run checks them.
// Watermarks: github:portfolio is set to the creation days the pilot read
// (2026-09-18 to 2026-11-11) and hn:comments to the pilot's time, so the
// first run continues from there; every other source starts fresh.
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { DISCOVERY_TABLES, RECHECK_DAYS, RECHECKED_REASONS, seenId } from "../lib/discovery/sites.mjs";
import { normalizeCandidate } from "../pipeline/discovery/normalize.mjs";
import { moveWatermark, readWatermark } from "../pipeline/discovery/watermark.mjs";

/** The seen-set source of a pilot source label. */
export function sourceOf(label) {
  const s = String(label);
  if (s.startsWith("topic:") || s.startsWith("user.github.io")) return "github";
  if (s.startsWith("hn:")) return "hn";
  if (s.startsWith("devto:")) return "devto";
  if (s.startsWith("curated:")) return "curated";
  return null;
}

// The pilot's check reasons, most telling first, as the seen-set's codes.
const CHECK_REASONS = [
  [/^(template|lorem_ipsum|placeholder_name)$/, "template"],
  [/^(robots_disallow|bot_challenge|http_40[13]|http_429)$/, "blocked"],
  [/^(dns_not_found|http_\d+|http_5xx|fetch_error|timeout)$/, "dead"],
  [/^parked_or_error_page$/, "parked"],
  [/^(empty_page|default_title_js_shell|default_title_little_text)$/, "empty"],
  [/^duplicate_final_url$/, "duplicate"],
  [/./, "not_portfolio"],
];

/** The coarse reason of a pilot row that failed the code checks. */
export function checkReason(reasons) {
  for (const [re, code] of CHECK_REASONS) if ((reasons ?? []).some((r) => re.test(r))) return code;
  return "not_portfolio";
}

/** The coarse reason of a pilot row the filter dropped. */
export function filterReason(reason) {
  const r = String(reason ?? "");
  if (r.startsWith("not English")) return "not_english";
  if (r === "unedited template text") return "template";
  return "not_portfolio";
}

const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** The pilot's rows as seen-set rows (pure apart from reading the files). */
export function pilotRows(dir) {
  const at = fs.statSync(path.join(dir, "candidates.jsonl")).mtime;
  const kept = readJsonl(path.join(dir, "kept.jsonl"));
  const enriched = readJsonl(path.join(dir, "enriched.jsonl"));
  const dropped = new Map(readJsonl(path.join(dir, "dropped.jsonl")).map((r) => [r.url, r]));
  const keptAt = new Map(kept.map((r, i) => [r.url, { r, e: enriched[i] ?? {} }]));
  const rows = [];
  const add = (raw, fields) => {
    const n = normalizeCandidate(raw.url);
    const source = sourceOf(raw.source);
    if (n.ok && source) rows.push({ id: seenId(n.url), url: n.url, source, ...fields });
  };
  const candidates = readJsonl(path.join(dir, "candidates.jsonl"));
  for (const c of candidates) {
    if (!c.likely) add(c, { status: "dropped", reason: checkReason(c.reasons) });
    else if (dropped.has(c.url)) add(c, { status: "dropped", reason: filterReason(dropped.get(c.url).filter?.reason) });
    else if (keptAt.has(c.url)) {
      const { r, e } = keptAt.get(c.url);
      const evidence = {
        url: r.url,
        finalUrl: r.final_url ?? r.url,
        lang: null,
        title: String(r.title ?? "").slice(0, 200),
        description: String(r.description ?? "").slice(0, 300),
        headings: e.headings ?? [],
        text: String(e.text ?? r.snippet ?? "").slice(0, 1200),
        repoLinks: e.repo_links ?? 0,
        liveLinks: e.live_demo_links ?? 0,
        socials: e.socials ?? [],
        resume: Boolean(e.resume),
        linksGithub: Boolean(r.links_github),
        jsShell: (r.flags ?? []).includes("js_rendered"),
      };
      add(c, { status: "screen", work: { evidence, priority: r.filter?.priority ?? "normal", from: "pilot" } });
    }
  }
  const checked = new Set(candidates.map((c) => c.url));
  for (const g of readJsonl(path.join(dir, "collected.jsonl"))) {
    if (checked.has(g.url)) continue;
    add(g, { status: "found", work: g.repo ? { repo: g.repo, description: String(g.description ?? "").slice(0, 200), topics: (g.topics ?? []).slice(0, 20) } : null });
  }
  return { at, rows };
}

/** Writes the rows (existing ones untouched) and the two watermarks. Returns how many were new. */
export async function importPilot(db, { at, rows }) {
  await db.batch(DISCOVERY_TABLES, "write");
  const iso = at.toISOString();
  let added = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const stmts = [];
    const isRow = [];
    for (const r of rows.slice(i, i + 200)) {
      const again = r.status === "dropped" && RECHECKED_REASONS.has(r.reason);
      const keepUrl = r.status !== "dropped" || again;
      const recheckAt = again ? new Date(at.getTime() + RECHECK_DAYS[r.reason] * 86400000).toISOString() : null;
      stmts.push({
        sql: `INSERT INTO discovery_sites (id, status, reason, source, first_seen, checked_at, recheck_at, tries, url)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        args: [r.id, r.status, r.status === "dropped" ? r.reason : null, r.source, iso, iso, recheckAt, r.status === "dropped" ? 1 : 0, keepUrl ? r.url : null],
      });
      isRow.push(true);
      if (r.work) {
        stmts.push({ sql: "INSERT INTO discovery_work (id, data) VALUES (?, ?) ON CONFLICT(id) DO NOTHING", args: [r.id, JSON.stringify(r.work)] });
        isRow.push(false);
      }
    }
    const res = await db.batch(stmts, "write");
    res.forEach((x, j) => {
      if (isRow[j]) added += x.rowsAffected;
    });
  }
  // Watermarks only where nothing newer is recorded.
  if (!(await readWatermark(db, "github:portfolio")).readAt) await moveWatermark(db, "github:portfolio", { newest: "2026-11-11", oldest: "2026-09-18" }, { now: at });
  if (!(await readWatermark(db, "hn:comments")).readAt) await moveWatermark(db, "hn:comments", { after: Math.floor(at.getTime() / 1000) }, { now: at });
  return added;
}

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: node scripts/discovery-import.mjs <pilot folder> [--dry-run]");
  const pilot = pilotRows(dir);
  const by = {};
  for (const r of pilot.rows) by[`${r.status}${r.reason ? `:${r.reason}` : ""}`] = (by[`${r.status}${r.reason ? `:${r.reason}` : ""}`] ?? 0) + 1;
  console.log(JSON.stringify({ rows: pilot.rows.length, by }, null, 2));
  if (process.argv.includes("--dry-run")) return;
  const env = process.env;
  const db = env.TURSO_DATABASE_URL
    ? createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN })
    : createClient({ url: `file:${env.LOCAL_DB_FILE ?? path.join(process.cwd(), "data", "portfoliorank.db")}` });
  console.log(`imported ${await importPilot(db, pilot)} new row(s)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
