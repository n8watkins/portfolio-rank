#!/usr/bin/env node
// The page text and measured facts a grade reads (pipeline/rubric.mjs): stored
// by capture.mjs for every capture since rubric v2, and measured here for
// rows captured before it. Measuring needs no Gemini, only plain HTTP and,
// for pages whose server sends little text, a real browser, which is why it
// runs on GitHub Actions: the end-of-day grading on Cloudflare
// (pipeline/night.mjs) grades only rows that already have their evidence.
//
// As a script (the nightly checks in sync-upstream.yml): measures and stores
// the evidence for listed, captured rows that are waiting for a grade or a
// re-grade and have none, at most --limit of them; then, with --links N,
// measures again up to N rows whose project link checks are due by the
// check rule (lib/freshness.mjs: the page changed, the admin or the owner
// asked, or the checks are 30 days old, since links rot without the page
// changing), without a new capture.
//
//   node pipeline/evidence.mjs [--limit N] [--links N] [--no-browser]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { measurePage } from "./facts.mjs";
import { httpGate, UA, visibleText } from "./gate.mjs";
import { normalizePageText } from "./rubric.mjs";
import { ACTIVE } from "./roster.mjs";
import { PRIMARY_MODEL } from "./gemini.mjs";

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
 * `force` measures again even when evidence is stored (the link re-checks).
 */
export async function pageEvidence(db, row, { renderer = null, force = false } = {}) {
  const url = String(row.url);
  const m = parseJson(row.meta)?.motion;
  const motion = typeof m === "boolean" ? m : null;
  const stored = parseJson(row.facts);
  if (row.page_text != null && stored && !force) {
    return { pageText: String(row.page_text), facts: stored.motion == null && motion != null ? { ...stored, motion } : stored, measured: false };
  }
  const gate = await httpGate(url).catch(() => null);
  if (gate?.status !== "live") {
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
  const facts = await measurePage(
    { html: page.html, text, url, finalUrl: page.finalUrl, name: String(row.name ?? ""), motion, source: page.source },
    { userAgent: UA }
  );
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
 * Listed, captured rows with no stored evidence that are waiting for a grade
 * (no grade yet) or a re-grade (a grade not made by the primary model, or,
 * with `versionRegrade`, one from an older rubric), oldest work first.
 */
export async function rowsNeedingEvidence(db, { limit = 200, rubricVersion = null } = {}) {
  const res = await db.execute({
    sql: `SELECT url, name, meta, page_text, facts FROM portfolios
          WHERE status = 'live' AND shot_key IS NOT NULL AND ${ACTIVE()}
            AND (page_text IS NULL OR facts IS NULL)
            AND (ai_rubric IS NULL
                 OR (json_extract(ai_rubric, '$.error') IS NULL
                     AND (COALESCE(json_extract(ai_rubric, '$.model'), '') != ?
                          ${rubricVersion ? "OR COALESCE(json_extract(ai_rubric, '$.rubric_version'), 1) < ?" : ""})))
          ORDER BY ai_rubric IS NOT NULL, needs_review DESC, captured_at DESC, url
          LIMIT ?`,
    args: rubricVersion ? [PRIMARY_MODEL, rubricVersion, limit] : [PRIMARY_MODEL, limit],
  });
  return res.rows;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { pipelineDb, ensureRosterSchema } = await import("./roster.mjs");
  const { createRenderer } = await import("./render.mjs");
  const { RUBRIC_VERSION } = await import("./rubric.mjs");
  const args = process.argv.slice(2);
  const i = args.indexOf("--limit");
  const limit = i >= 0 ? Number(args[i + 1]) : 200;
  const j = args.indexOf("--links");
  const linksLimit = j >= 0 ? Number(args[j + 1]) : 0;
  const { ensureFreshnessSchema, linksDue } = await import("../lib/freshness.mjs");
  const ROOT = path.join(import.meta.dirname, "..");
  const db = pipelineDb(ROOT);
  await ensureRosterSchema(db);
  const regradeOld = String(process.env.RUBRIC_REGRADE ?? "").toLowerCase() === "true";
  const rows = await rowsNeedingEvidence(db, { limit, rubricVersion: regradeOld ? RUBRIC_VERSION : null });
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
  const lines = [`evidence: measured ${measured} of ${rows.length} row(s) waiting for a grade without page text or facts`];
  if (linksLimit > 0) lines.push(`links: checked again ${relinked} of ${linkRows.length} site(s) whose link checks were due`);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}
