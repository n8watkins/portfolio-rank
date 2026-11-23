#!/usr/bin/env node
// The page text and measured facts a grade reads (pipeline/rubric.mjs): stored
// by capture.mjs for every capture since rubric v2, and measured here for
// rows captured before it. Measuring needs no Gemini, only plain HTTP and,
// for pages whose server sends little text, a real browser, which is why it
// runs on GitHub Actions: the end-of-day grading on Cloudflare
// (pipeline/night.mjs) grades only rows that already have their evidence.
//
// As a script (the nightly checks in sync-upstream.yml): measures and stores
// the evidence for listed, captured rows that are waiting for their first
// grade and have none, at most --limit of them (a site is graded once and
// never re-graded automatically, owner 2026-11-21); then, with --links N,
// measures again up to N rows whose project link checks are due by the
// check rule (lib/freshness.mjs: the admin or the owner asked, or the checks are 30 days old, since links rot without the page
// changing), without a new capture.
//
//   node pipeline/evidence.mjs [--limit N] [--links N] [--no-browser]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkLinks, measurePage, newProjectRule } from "./facts.mjs";
import { httpGate, UA, visibleText } from "./gate.mjs";
import { normalizePageText } from "./rubric.mjs";
import { ACTIVE, AI_WORK } from "./roster.mjs";
import { storedMs } from "../lib/stored-time.mjs";

// Below this much server-rendered text a page is treated as client-rendered
// and loaded in a browser instead (an offline sample of 30 sites found 40%
// of them under 200 characters over plain HTTP).
export const RENDER_BELOW_CHARS = 200;

const parseJson = (v) => {
  if (v == null) return null;
  try {
    const o = JSON.parse(String(v));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
};

/**
 * The page text and facts for a grade: the stored ones, or, for a row
 * captured before facts existed, measured now (free) and stored: over plain
 * HTTP, or in a browser (`renderer`, pipeline/render.mjs) when the server
 * sends little text. Motion always comes from the capture (meta.motion).
 * `force` is the link re-check: when evidence is stored it renews only the
 * project link results (facts.project_links and the time of the check), by
 * never the settled, browser-rendered page text or the signals measured from
 * it. Facts of version 3 have the capture's own list (facts.project_candidates,
 * from the desktop and phone views and the projects page): those links are
 * checked again, and a plain fetch, a weaker reading, never picks new ones.
 * Facts of version 1 and 2 keep their re-check as it was: the links are found
 * on a plain fetch of the page and checked, and the stored version stays (so
 * they keep their own rule). Either way the check is recorded (facts_at), so
 * the due list always moves on. A site with no page text or facts is measured
 * as usual.
 * `fetchImpl` is for tests (the page fetch and the link checks).
 */
export async function pageEvidence(db, row, { renderer = null, force = false, fetchImpl = globalThis.fetch } = {}) {
  const url = String(row.url);
  const m = parseJson(row.meta)?.motion;
  const motion = typeof m === "boolean" ? m : null;
  const stored = parseJson(row.facts);
  if (row.page_text != null && stored && !force) {
    return { pageText: String(row.page_text), facts: stored.motion == null && motion != null ? { ...stored, motion } : stored, measured: false };
  }
  const relinkOnly = force && row.page_text != null && Boolean(stored);
  if (relinkOnly && newProjectRule(stored.v)) {
    // Version 3: the links the capture chose, checked again; only which of them load is renewed.
    const chosen = Array.isArray(stored.project_candidates)
      ? stored.project_candidates.map((c) => (typeof c === "string" ? { url: c, kind: "outbound" } : c)).filter((c) => typeof c?.url === "string")
      : [];
    const at = new Date().toISOString();
    // No list (none should lack one): the check is still recorded, so the due list moves on.
    const facts = chosen.length || stored.project_candidates ? { ...stored, project_links: await checkLinks(chosen, { fetchImpl, userAgent: UA }), measured_at: at } : stored;
    try {
      await db.execute({ sql: "UPDATE portfolios SET facts = ?, facts_at = ? WHERE url = ?", args: [JSON.stringify(facts), at, url] });
    } catch {
      /* the checks come due again tomorrow */
    }
    return { pageText: String(row.page_text), facts, measured: true };
  }
  const gate = await httpGate(url, { fetchImpl }).catch(() => null);
  if (gate?.status !== "live") {
    if (relinkOnly) {
      // The page did not answer: the stored links stand, and the check is recorded so the due list moves on.
      await db.execute({ sql: "UPDATE portfolios SET facts_at = ? WHERE url = ?", args: [new Date().toISOString(), url] }).catch(() => {});
      return { pageText: String(row.page_text), facts: stored, measured: false };
    }
    return { pageText: "", facts: motion == null ? null : { source: "capture", motion }, measured: false };
  }
  let page = { html: gate.html, text: visibleText(gate.html), finalUrl: gate.finalUrl, source: "http" };
  if (page.text.length < RENDER_BELOW_CHARS && renderer) {
    const r = await renderer.render(url).catch(() => null);
    if (r && r.status < 400 && String(r.text ?? "").trim().length > page.text.length) {
      page = { html: r.html, text: String(r.text), finalUrl: r.finalUrl, source: "rendered" };
    }
  }
  const { text } = page;
  const measuredFacts = await measurePage(
    { html: page.html, text, url, finalUrl: page.finalUrl, name: String(row.name ?? ""), motion, source: page.source },
    { userAgent: UA, fetchImpl }
  );
  if (relinkOnly) {
    // The plain fetch only finds the links to check. Its text and signals are
    // thinner than the capture's rendered ones, so they are not stored.
    const facts = { ...stored, project_links: measuredFacts.project_links, measured_at: measuredFacts.measured_at };
    try {
      await db.execute({
        sql: "UPDATE portfolios SET facts = ?, facts_at = ? WHERE url = ?",
        args: [JSON.stringify(facts), facts.measured_at, url],
      });
    } catch {
      /* the checks come due again tomorrow */
    }
    return { pageText: String(row.page_text), facts, measured: true };
  }
  const facts = measuredFacts;
  const pageText = normalizePageText(text);
  try {
    await db.execute({
      sql: "UPDATE portfolios SET page_text = ?, facts = ?, facts_at = ? WHERE url = ?",
      args: [pageText, JSON.stringify(facts), facts.measured_at, url],
    });
  } catch {
    /* the grade still uses them; the next grade measures again */
  }
  return { pageText, facts, measured: true };
}

/**
 * Listed, captured rows with no stored evidence that are waiting for their
 * first grade (no grade yet), most urgent first.
 */
export async function rowsNeedingEvidence(db, { limit = 200 } = {}) {
  const res = await db.execute({
    sql: `SELECT url, name, meta, page_text, facts, captured_at FROM portfolios
          WHERE status = 'live' AND shot_key IS NOT NULL AND ${AI_WORK()}
            AND (page_text IS NULL OR facts IS NULL)
            AND ai_rubric IS NULL
          ORDER BY needs_review DESC, captured_at DESC, url
          LIMIT ?`,
    args: [limit],
  });
  return res.rows;
}

const DAY_MS = 86400000;

/** Whole nights since a row's capture (SQLite "YYYY-MM-DD HH:MM:SS", UTC), or null. */
export function nightsSince(capturedAt, now = Date.now()) {
  const t = storedMs(capturedAt);
  return t != null ? Math.max(0, Math.floor((now - t) / DAY_MS)) : null;
}

/**
 * The sites that still have no evidence after a run: how many, and the
 * longest-waiting `show` of them with the nights since their capture (a lower
 * bound on the wait: the capture is when they first qualified).
 */
export async function sitesStillWaiting(db, { show = 25, now = Date.now() } = {}) {
  const all = await rowsNeedingEvidence(db, { limit: 1000000 });
  const sites = all
    .map((r) => ({ url: String(r.url), nights: nightsSince(r.captured_at, now) }))
    .sort((a, b) => (b.nights ?? -1) - (a.nights ?? -1) || a.url.localeCompare(b.url));
  return { total: sites.length, sites: sites.slice(0, show) };
}

/** The run's log and step-summary lines. */
export function reportLines({ measured, waitingForRun, relinked = null, linkTotal = 0, still }) {
  const lines = [`evidence: measured ${measured} of ${waitingForRun} row(s) waiting for a grade without page text or facts`];
  if (relinked != null) lines.push(`links: checked again ${relinked} of ${linkTotal} site(s) whose link checks were due`);
  lines.push(`evidence: ${still.total} site(s) still without evidence after this run${still.total ? " (not graded until the page is reachable or captured again)" : ""}`);
  for (const s of still.sites) lines.push(`  - ${s.url} - ${s.nights == null ? "capture time unknown" : `${s.nights} night(s) since its capture`}`);
  if (still.total > still.sites.length) lines.push(`  ... and ${still.total - still.sites.length} more`);
  return lines;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { pipelineDb, ensureRosterSchema } = await import("./roster.mjs");
  const { createRenderer } = await import("./render.mjs");
  const args = process.argv.slice(2);
  const i = args.indexOf("--limit");
  const limit = i >= 0 ? Number(args[i + 1]) : 200;
  const j = args.indexOf("--links");
  const linksLimit = j >= 0 ? Number(args[j + 1]) : 0;
  const { ensureFreshnessSchema, linksDue } = await import("../lib/freshness.mjs");
  const ROOT = path.join(import.meta.dirname, "..");
  const db = pipelineDb(ROOT);
  await ensureRosterSchema(db);
  const rows = await rowsNeedingEvidence(db, { limit });
  const renderer = args.includes("--no-browser") ? null : createRenderer();
  let measured = 0;
  let relinked = 0;
  let linkRows = [];
  try {
    for (const [n, row] of rows.entries()) {
      const out = await pageEvidence(db, row, { renderer });
      if (out.measured) measured++;
      console.log(`[${n + 1}/${rows.length}] ${row.url} - ${out.measured ? `${out.pageText.length} characters, facts from ${out.facts?.source ?? "?"}` : "not reachable, left for the next run"}`);
    }
    if (linksLimit > 0) {
      await ensureFreshnessSchema(db);
      linkRows = await linksDue(db, { limit: linksLimit, active: ACTIVE });
      for (const [n, row] of linkRows.entries()) {
        const out = await pageEvidence(db, row, { renderer, force: true });
        if (out.measured) relinked++;
        const l = out.facts?.project_links;
        console.log(`[links ${n + 1}/${linkRows.length}] ${row.url} - ${out.measured ? `${l?.checked ?? 0} link(s) checked, ${l?.broken ?? 0} broken` : "not reachable, left for the next run"}`);
      }
    }
  } finally {
    await renderer?.close();
  }
  const still = await sitesStillWaiting(db);
  const lines = reportLines({ measured, waitingForRun: rows.length, relinked: linksLimit > 0 ? relinked : null, linkTotal: linkRows.length, still });
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}
