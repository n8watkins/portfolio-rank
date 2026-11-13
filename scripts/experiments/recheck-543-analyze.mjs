#!/usr/bin/env node
// The decisions of "recheck-543" (scripts/experiments/recheck-543.mjs), from
// the fresh captures, the code rules and the two graders' answers. Pure and
// local: it reads RECHECK_DIR and writes RECHECK_DIR/results.json (one entry
// per site), queue.json (the status_reviews rows) and stats.json (the
// numbers the report shows). Nothing is applied anywhere.
//
// Per site, in order:
//   capture failed           nothing changes (it stays as it is); listed in the report
//   capture blocked          review: never graded (owner: never grade a gate)
//   placeholder rule         not a portfolio, by code (pipeline/junk-rules.mjs)
//   same text elsewhere      review
//   otherwise                Gemini 3.1 batched and Haiku batched, each after the
//                            strong-signals guard (pipeline/portfolio-guard.mjs):
//                            agree -> that verdict, pre-ticked; disagree -> flagged
// A change is proposed when the verdict differs from the site's state: a
// portfolio that is out (graded not a portfolio, hidden or delisted) would
// be relisted; a listed, never-graded site that is not a portfolio would be
// removed. Only changes (and reviews) become queue rows.
//
//   node scripts/experiments/recheck-543-analyze.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildDupIndex, junkCheck } from "../../pipeline/junk-rules.mjs";
import { guardVerdict } from "../../pipeline/portfolio-guard.mjs";
import { actionNote } from "../../pipeline/splash.mjs";
import { readJson, writeJson } from "./grading-two-sets-lib.mjs";
import { BOT_CHECK, DIR, EXTRA, GROUPS, JOB, PROMPT_VERSION, SET } from "./recheck-543.mjs";

const PARTS = ["visual_design", "project_presentation", "writing"];

/** A grader's answer as the queue shows it. */
export const verdictOf = (a) => (a ? { is_portfolio: a.is_portfolio.answer, reason: a.is_portfolio.reason, scores: Object.fromEntries(PARTS.map((p) => [p, a[p].score])) } : null);

/** Answers by id for one model folder: { batch: Map, solo: Map }; a padded site's second batch answer is ignored. */
export function readAnswers(dir) {
  const out = { batch: new Map(), solo: new Map() };
  for (const step of ["batch", "solo"]) {
    const d = path.join(dir, step);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).sort()) {
      const r = readJson(path.join(d, f));
      for (const [id, a] of Object.entries(r.answers)) {
        if ((r.pad ?? []).includes(id)) continue;
        if (!out[step].has(id)) out[step].set(id, a);
      }
    }
  }
  return out;
}

/** Whether the site is out of the list now: graded not a portfolio, hidden or delisted. */
export const isOut = (s) => s.group !== "live_ungraded";

/** The proposed change for a verdict (true: a portfolio), or null when nothing would change. */
export function changeFor(site, portfolio) {
  if (portfolio && isOut(site)) return "relist";
  if (!portfolio && !isOut(site)) return "remove";
  return null;
}

/**
 * One site's decision. `g` and `h` are the batched answers of Gemini 3.1 and
 * Haiku (raw, before the guard); `meta` the capture's meta.json.
 */
export function decide(site, meta, { g, h, dupIndex }) {
  const signals = meta?.signals ?? null;
  const capture = {
    action: meta ? actionNote({ splash: meta.gate?.desktop, modal: meta.modal?.desktop, mode: meta.mode_pick?.desktop }) : null,
    // A bot or security check that stood in for the site is a blocked capture too, even when it had words enough.
    blocked: meta?.blocked ?? (meta && !meta.failed && BOT_CHECK.test(meta.page_text ?? "") ? "a bot or security check stood in for the site" : null),
    failed: meta ? meta.failed ?? null : "not captured",
    retried: Boolean(meta?.retried),
  };
  const base = { id: site.id, url: site.url, group: site.group, current: site.current, off_list: site.off_list, shot_key: site.shot_key, capture, signals };
  if (capture.failed) return { ...base, path: "capture_failed", outcome: "unchanged", proposed: null, agreed: null, reason: `The capture failed (${capture.failed}); the site stays as it is.` };
  if (capture.blocked) return { ...base, path: "capture_blocked", outcome: "needs_review", proposed: "review", agreed: false, reason: `Capture blocked, needs review: ${capture.blocked}. Not sent to any model.` };
  const hasWork = Boolean(signals?.projects);
  const junk = junkCheck({ url: site.url, name: site.name, page_text: meta.page_text, has_work: hasWork }, dupIndex);
  if (junk.junk) {
    const proposed = changeFor(site, false);
    return { ...base, junk: junk.rule, path: "code_rule", outcome: "not_portfolio", proposed, agreed: true, reason: `Code rule: ${junk.rule}.` };
  }
  if (junk.review) return { ...base, junk: junk.rule, path: "same_text", outcome: "needs_review", proposed: "review", agreed: false, reason: "The same page text is on another domain: a copy, or the original. A person decides." };
  const gg = g ? guardVerdict({ is_portfolio: g.is_portfolio.answer }, signals) : null;
  const hh = h ? guardVerdict({ is_portfolio: h.is_portfolio.answer }, signals) : null;
  const guarded = { gemini31: gg ? { portfolio: gg.is_portfolio, guard: Boolean(gg.review) } : null, haiku: hh ? { portfolio: hh.is_portfolio, guard: Boolean(hh.review) } : null };
  if (!gg || !hh) return { ...base, guarded, path: "graders", outcome: "pending", proposed: null, agreed: null, reason: `Waiting for ${!gg ? "Gemini 3.1" : "Haiku"}.` };
  const agreed = gg.is_portfolio === hh.is_portfolio;
  const guardNote = gg.review || hh.review ? " The strong-signals guard kept it a portfolio for at least one grader." : "";
  if (agreed) {
    const proposed = changeFor(site, gg.is_portfolio);
    return {
      ...base,
      guarded,
      path: "graders",
      outcome: gg.is_portfolio ? "portfolio" : "not_portfolio",
      proposed,
      agreed: true,
      reason: `Gemini 3.1 and Haiku agree: ${gg.is_portfolio ? "a portfolio" : "not a portfolio"}.${guardNote}`,
    };
  }
  // They disagree: the change one of them asks for, flagged and never pre-ticked.
  const proposed = changeFor(site, true) ?? changeFor(site, false);
  return { ...base, guarded, path: "graders", outcome: "disagree", proposed, agreed: false, reason: `The graders disagree: Gemini 3.1 says ${gg.is_portfolio ? "a portfolio" : "not a portfolio"}, Haiku says ${hh.is_portfolio ? "a portfolio" : "not a portfolio"}.${guardNote}` };
}

/** The status_reviews row of a decision, or null when nothing would change. */
export function queueRow(d, verdicts, now = new Date().toISOString()) {
  if (!d.proposed) return null;
  return {
    batch: JOB,
    url: d.url,
    grp: d.group,
    current: d.current,
    proposed: d.proposed,
    agreed: d.agreed ? 1 : 0,
    reason: d.reason,
    off_list: d.off_list ? 1 : 0,
    shot_key: d.shot_key,
    verdicts: JSON.stringify(verdicts),
    signals: JSON.stringify({
      score: d.signals?.score ?? null,
      names: d.signals ? ["name", "projects", "about", "contact", "resume", "github"].filter((k) => d.signals[k] === true) : [],
      junk_rule: d.junk ?? null,
      capture: { action: d.capture.action, blocked: d.capture.blocked, failed: d.capture.failed },
    }),
    status: "pending",
    created_at: now,
  };
}

export function analyze(dir = DIR) {
  const sel = readJson(path.join(dir, "selection.json"));
  const metaOf = (id) => {
    const p = path.join(dir, "bundles", SET, id, "meta.json");
    return fs.existsSync(p) ? readJson(p) : null;
  };
  const metas = new Map(sel.sites.map((s) => [s.id, metaOf(s.id)]));
  // The text index: every stored page text (selection time) plus the fresh captures.
  const dupIndex = new Map(Object.entries(fs.existsSync(path.join(dir, "dups.json")) ? readJson(path.join(dir, "dups.json")) : {}).map(([h, hosts]) => [h, new Set(hosts)]));
  const fresh = buildDupIndex(sel.sites.filter((s) => metas.get(s.id)?.page_text).map((s) => ({ url: s.url, page_text: metas.get(s.id).page_text })));
  for (const [h, hosts] of fresh) {
    if (!dupIndex.has(h)) dupIndex.set(h, new Set());
    for (const x of hosts) dupIndex.get(h).add(x);
  }
  const plan = fs.existsSync(path.join(dir, "gemini31", "plan.json")) ? readJson(path.join(dir, "gemini31", "plan.json")) : null;
  const g31 = readAnswers(path.join(dir, "gemini31"));
  // Gemini's batch files don't list padding: take each padded id's answer from its first (unpadded) batch only.
  if (plan) {
    g31.batch = new Map();
    // The full run, then the extra batch (sites that loaded only from the owner's machine).
    const extraPlanPath = path.join(EXTRA, "plan.json");
    // The extra batch first: a site in it was re-captured, so its answer there replaces any
    // answer the full run gave on the failed or bot-check capture.
    const runs = [...(fs.existsSync(extraPlanPath) ? [[readJson(extraPlanPath), path.join(dir, "gemini31-extra", "batch")]] : []), [plan, path.join(dir, "gemini31", "batch")]];
    for (const [p, files] of runs) {
      for (const r of p.requests.filter((x) => x.kind === "batch")) {
        const f = path.join(files, `${r.key.split("/")[1]}.json`);
        if (!fs.existsSync(f)) continue;
        const answers = readJson(f).answers;
        for (const id of r.ids) if (!(r.pad ?? []).includes(id) && !g31.batch.has(id) && answers[id]) g31.batch.set(id, answers[id]);
      }
    }
  }
  const hk = readAnswers(path.join(dir, "haiku"));
  // Haiku's extra batch (e01...) and its solo-extra answers replace answers given on the old capture.
  const extraIds = new Set(fs.existsSync(path.join(EXTRA, "plan.json")) ? readJson(path.join(EXTRA, "plan.json")).requests.flatMap((r) => r.ids.filter((id) => !(r.pad ?? []).includes(id))) : []);
  const hkDir = path.join(dir, "haiku");
  for (const id of extraIds) {
    hk.batch.delete(id);
    hk.solo.delete(id);
  }
  for (const f of fs.existsSync(path.join(hkDir, "batch")) ? fs.readdirSync(path.join(hkDir, "batch")).filter((x) => x.startsWith("e")) : []) {
    const r = readJson(path.join(hkDir, "batch", f));
    for (const [id, a] of Object.entries(r.answers)) if (extraIds.has(id) && !(r.pad ?? []).includes(id)) hk.batch.set(id, a);
  }
  for (const f of fs.existsSync(path.join(hkDir, "solo-extra")) ? fs.readdirSync(path.join(hkDir, "solo-extra")) : []) {
    const r = readJson(path.join(hkDir, "solo-extra", f));
    for (const [id, a] of Object.entries(r.answers)) if (extraIds.has(id)) hk.solo.set(id, a);
  }
  const results = [];
  const queue = [];
  for (const s of sel.sites) {
    const meta = metas.get(s.id);
    const d = decide(s, meta, { g: g31.batch.get(s.id), h: hk.batch.get(s.id), dupIndex });
    const verdicts = {
      prompt: PROMPT_VERSION,
      gemini31: { batch: verdictOf(g31.batch.get(s.id)), solo: verdictOf(g31.solo.get(s.id)) },
      haiku: { batch: verdictOf(hk.batch.get(s.id)), solo: verdictOf(hk.solo.get(s.id)) },
    };
    results.push({ ...d, name: s.name, verdicts });
    const row = queueRow(d, verdicts);
    if (row) queue.push(row);
  }
  return { results, queue, groups: GROUPS };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { results, queue } = analyze();
  writeJson(path.join(DIR, "results.json"), results);
  writeJson(path.join(DIR, "queue.json"), queue);
  const count = (f) => results.filter(f).length;
  console.log(`${results.length} sites: ${JSON.stringify(Object.fromEntries(["capture_failed", "capture_blocked", "code_rule", "same_text", "graders"].map((p) => [p, count((r) => r.path === p)])))}`);
  console.log(`outcomes: ${JSON.stringify(Object.fromEntries(["portfolio", "not_portfolio", "disagree", "needs_review", "pending", "unchanged"].map((o) => [o, count((r) => r.outcome === o)])))}`);
  console.log(`queue rows: ${queue.length} (${queue.filter((q) => q.agreed).length} agreed, ${queue.filter((q) => !q.agreed).length} flagged)`);
}
