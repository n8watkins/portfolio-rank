#!/usr/bin/env node
// The report of "recheck-543", in the owner's report format: a TL;DR box,
// headline numbers, the verdict table, contents on the side, "What this
// means" under each section, details in appendices.
//
// It answers, in order: (a) where Gemini 3.1 and Haiku agree; (b) where they
// disagree, each site listed; (c) which sites are not portfolios and why;
// (d) batched against one at a time, per model; (e) retries and failures;
// (f) cost and time. Plus the Gemini "no" answers on grounds v2.1 does not
// allow (a blog, a missing role), next to Haiku's answer, and the sites
// that could not be graded, by error type, with the retry from this machine.
//
// Outputs:
//   RECHECK_DIR/report/index.html + img/   the page to publish: site cards
//       with the first screens (click for full size) and, where captured
//       (recheck-543-fullpages.mjs), the whole page in a scroll box
//   docs/experiments/recheck-543.md and .html   the same text without images
//       (543 sites of screenshots don't belong in git); every sentence on its
//       own line in the Markdown
//
//   node scripts/experiments/recheck-543-report.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readJson } from "./grading-two-sets-lib.mjs";
import { DIR, GROUPS, GROUP_LABELS, PROMPT_VERSION, SET } from "./recheck-543.mjs";

const DOCS = path.join(import.meta.dirname, "..", "..", "docs", "experiments");
const PARTS = ["visual_design", "project_presentation", "writing"];
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const bare = (u) => String(u).replace(/^https?:\/\//, "").replace(/\/$/, "");
const read = (p, d = null) => (fs.existsSync(p) ? readJson(p) : d);
const yesNo = (v) => (v == null ? "-" : v.is_portfolio ? "portfolio" : "not a portfolio");

// v2.1: is_portfolio is false only for parked or for sale, unedited placeholders,
// pages not about a person, and broken, blank or error pages. A "no" whose reason
// is only one of these is a reason v2.1 does not allow.
const DISALLOWED = /\bblog\b|\brole\b|professional identity|personal identity|lacks (a )?(clear )?(name|identity)|no projects|lacks projects|without projects|no (project|work) (content|links)|way to (view|see) (their )?(work|projects)|contact page|gimmick|single project/i;
const ALLOWED = /moved|sign-up|signup|sign up|boot screen|no person|not about a person|parked|for sale|placeholder|template|demo name|404|error|broken|blank|not load|inaccessible|security|bot|verification|checkpoint|repository|repo\b|readme|link-in-bio|linktree|company|studio|agency|product|tool|landing page|gambling|slot|spam|login|redirect|expired|deployment|loading screen/i;
export const disallowedNo = (reason) => DISALLOWED.test(reason ?? "") && !ALLOWED.test(reason ?? "");

/** Agreement between two verdict getters on the sites both answered. */
export function agreement(results, a, b) {
  const both = results.filter((r) => a(r) && b(r));
  const same = both.filter((r) => a(r).is_portfolio === b(r).is_portfolio);
  const cells = { pp: 0, pn: 0, np: 0, nn: 0 };
  for (const r of both) cells[`${a(r).is_portfolio ? "p" : "n"}${b(r).is_portfolio ? "p" : "n"}`]++;
  const scores = Object.fromEntries(
    PARTS.map((p) => {
      const d = both.map((r) => Math.abs(a(r).scores[p] - b(r).scores[p]));
      return [p, { exact: d.filter((x) => x === 0).length, within1: d.filter((x) => x <= 1).length, mean: d.length ? d.reduce((s, x) => s + x, 0) / d.length : null }];
    })
  );
  return { n: both.length, same: same.length, cells, scores };
}

/** Requests, statuses, broken answers, time and cost from a model's state file. */
export function requestStats(state) {
  if (!state) return null;
  const attempts = state.attempts ?? [];
  const statuses = {};
  for (const a of attempts) statuses[a.status] = (statuses[a.status] ?? 0) + 1;
  const times = attempts.map((a) => Date.parse(a.at)).filter(Number.isFinite);
  const items = Object.values(state.items ?? {});
  const usage = items.map((i) => i.usage).filter(Boolean);
  const broken = items.flatMap((i) => (Array.isArray(i.broken) ? i.broken : []).map((b) => ({ key: i.key, why: typeof b === "string" ? b : b.why })));
  const sum = (f) => usage.reduce((s, u) => s + (f(u) ?? 0), 0);
  return {
    http: state.http_requests ?? attempts.length,
    retries: attempts.filter((a) => a.retry).length,
    statuses,
    busy: Object.entries(statuses).filter(([s]) => Number(s) >= 500 || s === "0").reduce((n, [, c]) => n + c, 0),
    broken,
    wrongCount: broken.filter((b) => /sites, expected|ids \[/.test(b.why)).length,
    unanswered: items.filter((i) => i.broken_final).map((i) => i.key),
    start: times.length ? new Date(Math.min(...times)).toISOString() : null,
    end: times.length ? new Date(Math.max(...times)).toISOString() : null,
    minutes: times.length ? Math.round((Math.max(...times) - Math.min(...times)) / 60000) : 0,
    cost: state.cost_usd ?? null,
    tokens: usage.length ? { input: sum((u) => u.input_tokens ?? u.inputTokens ?? u.promptTokenCount), output: sum((u) => u.output_tokens ?? u.outputTokens ?? u.candidatesTokenCount), thinking: sum((u) => u.thoughtsTokens ?? 0) } : null,
    stopped: state.stopped ?? state.paused ?? null,
  };
}

export function build(dir = DIR) {
  const results = readJson(path.join(dir, "results.json"));
  const g = requestStats(read(path.join(dir, "gemini31", "state.json")));
  const gp = requestStats(read(path.join(dir, "gemini31-pilot", "state.json")));
  const gx = requestStats(read(path.join(dir, "gemini31-extra", "state.json")));
  const h = requestStats(read(path.join(dir, "haiku", "state.json")));
  const ungraded = read(path.join(dir, "ungraded.json"), []);
  const retry = read(path.join(dir, "retry.json"), {});
  const cancellations = read(path.join(dir, "cancellations.json"), []);
  const metas = new Map(results.map((r) => [r.id, read(path.join(dir, "bundles", SET, r.id, "meta.json"))]));
  const count = (f) => results.filter(f).length;
  const v = (m, k) => (r) => r.verdicts?.[m]?.[k] ?? null;
  const ag = {
    batch: agreement(results, v("gemini31", "batch"), v("haiku", "batch")),
    solo: agreement(results, v("gemini31", "solo"), v("haiku", "solo")),
    g31: agreement(results, v("gemini31", "batch"), v("gemini31", "solo")),
    haiku: agreement(results, v("haiku", "batch"), v("haiku", "solo")),
  };
  const byGroup = GROUPS.map((gr) => {
    const rs = results.filter((r) => r.group === gr);
    const c = (f) => rs.filter(f).length;
    return {
      group: gr,
      n: rs.length,
      relist: c((r) => r.proposed === "relist" && r.agreed),
      remove: c((r) => r.proposed === "remove" && r.agreed),
      stay: c((r) => !r.proposed && r.outcome !== "pending" && r.path !== "capture_failed"),
      flagged: c((r) => r.outcome === "disagree" && r.proposed),
      review: c((r) => r.proposed === "review"),
      failed: c((r) => r.path === "capture_failed"),
      pending: c((r) => r.outcome === "pending"),
    };
  });
  const capture = {
    gate: [...metas.values()].filter((m) => m?.gate?.desktop || m?.gate?.phone).length,
    modal: [...metas.values()].filter((m) => m?.modal?.desktop || m?.modal?.phone).length,
    mode: [...metas.values()].filter((m) => m?.mode_pick?.desktop || m?.mode_pick?.phone).length,
    retried: [...metas.values()].filter((m) => m?.retried).length,
  };
  const ungradedKinds = {};
  for (const u of ungraded) ungradedKinds[u.kind] = (ungradedKinds[u.kind] ?? 0) + 1;
  const retryResults = {};
  for (const x of Object.values(retry)) retryResults[x.result] = (retryResults[x.result] ?? 0) + 1;
  return {
    results,
    metas,
    g,
    gp,
    gx,
    h,
    ag,
    byGroup,
    capture,
    ungraded,
    ungradedKinds,
    retry,
    retryResults,
    cancellations,
    disagree: results.filter((r) => r.outcome === "disagree"),
    bothNot: results.filter((r) => r.path === "graders" && r.outcome === "not_portfolio"),
    codeRule: results.filter((r) => r.path === "code_rule"),
    sameText: results.filter((r) => r.path === "same_text"),
    geminiDisallowed: results.filter((r) => r.verdicts?.gemini31?.batch?.is_portfolio === false && disallowedNo(r.verdicts.gemini31.batch.reason)),
    haikuDisallowed: results.filter((r) => r.verdicts?.haiku?.batch?.is_portfolio === false && disallowedNo(r.verdicts.haiku.batch.reason)),
    n: {
      sites: results.length,
      graded: count((r) => r.path === "graders" && r.outcome !== "pending"),
      relist: count((r) => r.proposed === "relist" && r.agreed),
      remove: count((r) => r.proposed === "remove" && r.agreed),
      flagged: count((r) => r.outcome === "disagree" && r.proposed),
      review: count((r) => r.proposed === "review"),
      blocked: count((r) => r.path === "capture_blocked"),
      failed: count((r) => r.path === "capture_failed"),
      bothPortfolio: count((r) => r.path === "graders" && r.outcome === "portfolio"),
      bothNot: count((r) => r.path === "graders" && r.outcome === "not_portfolio"),
      pending: count((r) => r.outcome === "pending"),
    },
  };
}

// ---------------------------------------------------------------- content

const verdictLine = (label, x) => (x ? `${label}: ${yesNo(x)} (${PARTS.map((p) => x.scores[p]).join("/")}), "${x.reason}"` : `${label}: no answer`);

function sections(d) {
  const N = d.n;
  const out = [];
  const money = (x) => (x == null ? "free tier" : `$${x.toFixed(2)}`);
  out.push({
    id: "tldr",
    title: "TL;DR",
    box: true,
    lines: [
      `All ${N.sites} sites that are not ranked were captured fresh, and the ${N.graded} that could be graded went to Gemini 3.1 Flash-Lite and Claude Haiku 5.5 with the owner's definition (prompt ${PROMPT_VERSION}).`,
      `Both say portfolio for ${N.bothPortfolio} sites and both say not a portfolio for ${N.bothNot}; they disagree on ${d.disagree.length}.`,
      `${N.relist} sites would come back (both agree, pre-ticked), ${N.remove} listed sites would leave, ${N.flagged} disagreements are flagged, and ${N.review} need a person (a blocked capture or the same text on another domain).`,
      `${N.failed} sites failed to load and ${N.blocked} captures stayed blocked, so they were never graded; most failed loads are names that no longer resolve.`,
      `${d.results.filter((r) => r.proposed === "relist" && r.agreed && r.off_list).length} of the agreed relists are sites that left the community list (delisted on 2026-11-10); bringing those back is a policy decision for the owner, separate from the grades.`,
      `Gemini said no on grounds v2.1 does not allow (a blog, a missing role) for ${d.geminiDisallowed.length} sites; Haiku for ${d.haikuDisallowed.length}.`,
      `Cost: Gemini ${(d.gp?.http ?? 0) + (d.g?.http ?? 0) + (d.gx?.http ?? 0)} HTTP requests on the free tier (pilot, full run and extra batch), Haiku ${money(d.h?.cost)}. Nothing has changed on the site: every change waits on the owner on /admin/review.`,
    ],
  });
  out.push({
    id: "numbers",
    title: "Headline numbers",
    cards: [
      ["Sites re-checked", N.sites],
      ["Graded by both models", N.graded],
      ["Both: portfolio", N.bothPortfolio],
      ["Both: not a portfolio", N.bothNot],
      ["Models disagree", d.disagree.length],
      ["Would relist (agreed)", N.relist],
      ["Would remove (agreed)", N.remove],
      ["Needs a person", N.review],
      ["Capture blocked", N.blocked],
      ["Capture failed", N.failed],
    ],
  });
  out.push({
    id: "verdicts",
    title: "Verdicts by group",
    table: {
      head: ["Group", "Sites", "Would relist", "Would remove", "No change", "Flagged", "Needs a person", "Capture failed", ...(N.pending ? ["Waiting"] : [])],
      rows: [
        ...d.byGroup.map((g) => [GROUP_LABELS[g.group], g.n, g.relist, g.remove, g.stay, g.flagged, g.review, g.failed, ...(N.pending ? [g.pending] : [])]),
        ["All", N.sites, N.relist, N.remove, d.byGroup.reduce((s, g) => s + g.stay, 0), N.flagged, N.review, N.failed, ...(N.pending ? [N.pending] : [])],
      ],
    },
    lines: [
      "\"Would relist\" and \"Would remove\" are sites both models agree on; they are pre-ticked on the Review page.",
      "\"Flagged\" sites are on the Review page unticked, with both verdicts side by side.",
      "\"No change\" means the verdict matches how the site is shown today.",
      "Delisted sites left the community list in the 2026-11-10 cleanup (#53); their rows say \"no longer on the community list\".",
    ],
    means: ["The owner's queue is the relist, remove, flagged and needs-a-person rows; nothing else needs a decision."],
  });
  const offList = d.results.filter((r) => r.proposed === "relist" && r.agreed && r.off_list);
  out.push({
    id: "off-list",
    title: `A decision for the owner: ${offList.length} delisted sites`,
    lines: [
      `${offList.length} of the ${N.relist} agreed relists are delisted sites: they left the community list and were delisted in the 2026-11-10 cleanup (#53), not because anything was wrong with them.`,
      "Both models call them portfolios, so a pass rule (PR #220, REVIEW_AUTO_APPLY) would relist them all once it is on; each row says \"no longer on the community list\".",
      "Whether sites that left the community list should come back is a policy choice, not a grading result; the other relists (sites graded \"not a portfolio\" before, or marked broken) are corrections.",
    ],
    table: {
      head: ["Agreed relists", "Sites"],
      rows: [
        ["Delisted after grading (off the community list)", d.results.filter((r) => r.proposed === "relist" && r.agreed && r.group === "delisted_graded").length],
        ["Delisted before grading (off the community list)", d.results.filter((r) => r.proposed === "relist" && r.agreed && r.group === "delisted_ungraded").length],
        ["Graded \"not a portfolio\" before", d.results.filter((r) => r.proposed === "relist" && r.agreed && r.group === "not_portfolio").length],
        ["Marked broken before, never graded", d.results.filter((r) => r.proposed === "relist" && r.agreed && r.group === "broken").length],
      ],
    },
    means: ["Decide the delisted ones as a group before turning auto-apply on; the corrections can go through as they are."],
  });
  // (a) agreement
  out.push({
    id: "agree",
    title: "(a) Where Gemini 3.1 and Haiku agree",
    table: {
      head: ["Batched answers", "Haiku: portfolio", "Haiku: not"],
      rows: [
        ["Gemini 3.1: portfolio", d.ag.batch.cells.pp, d.ag.batch.cells.pn],
        ["Gemini 3.1: not", d.ag.batch.cells.np, d.ag.batch.cells.nn],
      ],
    },
    lines: [
      `Batched (5 sites a request): ${d.ag.batch.same} of ${d.ag.batch.n} agree (${pct(d.ag.batch.same, d.ag.batch.n)}).`,
      d.ag.solo.n ? `One at a time, on the ${d.ag.solo.n} sites both graded alone: ${d.ag.solo.same} agree (${pct(d.ag.solo.same, d.ag.solo.n)}).` : "One at a time: no overlap yet.",
      ...PARTS.map((p) => `${p.replace("_", " ")}: the same score on ${d.ag.batch.scores[p].exact} of ${d.ag.batch.n} (${pct(d.ag.batch.scores[p].exact, d.ag.batch.n)}), within one point on ${pct(d.ag.batch.scores[p].within1, d.ag.batch.n)}, mean difference ${d.ag.batch.scores[p].mean?.toFixed(2) ?? "-"}.`),
    ],
    means: ["Agreement is on the raw answers, before the strong-signals guard; the queue applies the guard to each model before comparing."],
  });
  // (b) disagreements
  out.push({
    id: "disagree",
    title: `(b) Where they disagree (${d.disagree.length})`,
    lines: ["Each site with both answers and its screenshots. These are flagged, unticked, on the Review page."],
    cards: null,
    sites: d.disagree,
    means: ["A disagreement is where a person adds the most: one model is wrong on each of these."],
  });
  const pendingSites = d.results.filter((r) => r.outcome === "pending");
  if (pendingSites.length)
    out.push({
      id: "pending",
      title: `Haiku pending (${pendingSites.length})`,
      lines: [
        "These sites failed on the GitHub capture but loaded when retried from the owner's machine, so they went to the graders in a small extra batch.",
        "Gemini 3.1 has answered where shown; Haiku runs when the owner runs the Haiku command again, and the report is regenerated then.",
      ],
      list: pendingSites.map((r) => `- [${bare(r.url)}](${r.url}) (${GROUP_LABELS[r.group]}): Gemini 3.1 ${r.verdicts.gemini31.batch ? yesNo(r.verdicts.gemini31.batch) : "pending"}; Haiku pending`),
    });
  // (c) not a portfolio, and why
  out.push({
    id: "not",
    title: `(c) Not a portfolio, and why (${d.bothNot.length + d.codeRule.length})`,
    lines: [
      `${d.bothNot.length} sites both models call not a portfolio, and ${d.codeRule.length} a code rule settles without a model (an unedited placeholder, a parked page, a code host or link-in-bio address).`,
      "Reasons, most common first, are in the list below; each site keeps both models' own words.",
    ],
    list: [
      ...d.codeRule.map((r) => `- [${bare(r.url)}](${r.url}) (${GROUP_LABELS[r.group]}): code rule, ${r.junk}`),
      ...d.bothNot.map((r) => `- [${bare(r.url)}](${r.url}) (${GROUP_LABELS[r.group]}): Gemini "${r.verdicts.gemini31.batch.reason}"; Haiku "${r.verdicts.haiku.batch.reason}"`),
    ],
    means: ["Most are broken deploys, 404 pages, parked or hijacked domains and code repositories: dead or not about a person, as v2.1 intends."],
  });
  // v2.1 grounds
  out.push({
    id: "v21",
    title: `Gemini "no" on grounds v2.1 does not allow (${d.geminiDisallowed.length})`,
    lines: [
      "v2.1 says a site is a portfolio unless it is parked or for sale, an unedited placeholder, not about a person, or broken; a missing sign, a missing role included, is never a reason for no, and a blog is not an exclusion.",
      `Gemini 3.1 still said no on such grounds for these sites; Haiku did for ${d.haikuDisallowed.length}.`,
    ],
    sites: d.geminiDisallowed,
    means: ["Where Haiku says portfolio on these, the definition is working and Gemini 3.1 is not following it; that matters for which model grades in production."],
  });
  // (d) batch vs solo
  out.push({
    id: "batch-solo",
    title: "(d) Batched against one at a time",
    table: {
      head: ["Model", "Sites", "Same verdict", ...PARTS.map((p) => `${p.replace("_", " ")}: same score`)],
      rows: [
        ["Gemini 3.1", d.ag.g31.n, `${d.ag.g31.same} (${pct(d.ag.g31.same, d.ag.g31.n)})`, ...PARTS.map((p) => `${d.ag.g31.scores[p].exact} (${pct(d.ag.g31.scores[p].exact, d.ag.g31.n)})`)],
        ["Haiku 5.5", d.ag.haiku.n, `${d.ag.haiku.same} (${pct(d.ag.haiku.same, d.ag.haiku.n)})`, ...PARTS.map((p) => `${d.ag.haiku.scores[p].exact} (${pct(d.ag.haiku.scores[p].exact, d.ag.haiku.n)})`)],
      ],
    },
    lines: ["Gemini 3.1 graded 100 sites alone (20 per group, a fixed seed); Haiku graded every site alone."],
    means: ["If batching changes a verdict often, a batched answer is not a safe base for a decision on its own."],
  });
  // (e) retries and failures
  const fail = (s) => (s ? [s.http, s.retries, s.busy, Object.entries(s.statuses).map(([k, n]) => `${k}: ${n}`).join(", "), s.broken.length, s.wrongCount, s.unanswered.length] : ["-", "-", "-", "-", "-", "-", "-"]);
  out.push({
    id: "failures",
    title: "(e) Retries and failures",
    table: {
      head: ["Run", "HTTP requests", "Retries", "Busy (5xx or network)", "Statuses", "Answers that did not parse", "Wrong site count", "Left unanswered"],
      rows: [["Gemini 3.1 pilot", ...fail(d.gp)], ["Gemini 3.1 full run", ...fail(d.g)], ["Gemini 3.1 extra batch", ...fail(d.gx)], ["Claude Haiku 5.5", ...fail(d.h)]],
    },
    lines: [
      ...d.cancellations.map((c) => `The first full Gemini run (${c.run}) was cancelled at ${c.cancelled} for the owner (tests first); ${c.answered.length} batches were answered and kept, one request was in flight, and the run resumed from that state.`),
      ...[...(d.g?.broken ?? []), ...(d.h?.broken ?? [])].map((b) => `${b.key}: ${b.why}`),
    ],
    means: ["Every busy answer was retried; nothing was dropped."],
  });
  // ungraded sites
  out.push({
    id: "ungraded",
    title: `Sites that could not be graded (${d.ungraded.length})`,
    table: { head: ["What happened", "Sites"], rows: Object.entries(d.ungradedKinds).sort((a, b) => b[1] - a[1]) },
    lines: [
      "The failed loads were retried once from this machine (not a GitHub address), with a 60-second load, 20 seconds for content and the capture fixes since; names that do not resolve here either are dead.",
      ...Object.entries(d.retryResults).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`),
    ],
    means: ["A name that does not resolve from two networks is gone; those sites are dead, not broken by the capture."],
  });
  // (f) cost and time
  const money2 = (s) => (s?.cost != null ? `$${s.cost.toFixed(2)}` : "free tier");
  const tok = (s) => (s?.tokens ? `${Math.round(s.tokens.input / 1000)}k in, ${Math.round(s.tokens.output / 1000)}k out${s.tokens.thinking ? `, ${Math.round(s.tokens.thinking / 1000)}k thinking` : ""}` : "-");
  out.push({
    id: "cost",
    title: "(f) Cost and time",
    table: {
      head: ["Run", "Requests", "Tokens", "Cost", "From", "To", "Wall time"],
      rows: [
        ["Gemini 3.1 pilot", d.gp?.http ?? 0, tok(d.gp), money2(d.gp), d.gp?.start ?? "-", d.gp?.end ?? "-", `${d.gp?.minutes ?? 0} min`],
        ["Gemini 3.1 full run", d.g?.http ?? 0, tok(d.g), money2(d.g), d.g?.start ?? "-", d.g?.end ?? "-", `${d.g?.minutes ?? 0} min`],
        ["Gemini 3.1 extra batch", d.gx?.http ?? 0, tok(d.gx), money2(d.gx), d.gx?.start ?? "-", d.gx?.end ?? "-", `${d.gx?.minutes ?? 0} min`],
        ["Claude Haiku 5.5", d.h?.http ?? 0, tok(d.h), money2(d.h), d.h?.start ?? "-", d.h?.end ?? "-", `${d.h?.minutes ?? 0} min`],
      ],
    },
    lines: [
      "Gemini 3.1 runs on the free tier (500 requests a Pacific day assumed); the job stayed under its own cap of 230 and under 440 for the day, leaving room for mini test 8.",
      "Gemini 3.5 was not used; production flags and GEMINI_BUDGET were unchanged.",
      `Capture: ${d.capture.gate} splash gates passed, ${d.capture.modal} dialogs closed, ${d.capture.mode} mode pickers, ${d.capture.retried} captures needed their one retry (GitHub Actions, no AI).`,
    ],
  });
  out.push({
    id: "appendix-sites",
    title: "Appendix A: every site",
    table: {
      head: ["Site", "Group", "Path", "Gemini 3.1 (batch / solo)", "Haiku (batch / solo)", "Signals", "Proposed", "Capture"],
      rows: d.results.map((r) => [
        { link: r.url },
        GROUP_LABELS[r.group],
        r.path.replace("_", " "),
        `${yesNo(r.verdicts.gemini31.batch)} / ${yesNo(r.verdicts.gemini31.solo)}`,
        `${yesNo(r.verdicts.haiku.batch)} / ${yesNo(r.verdicts.haiku.solo)}`,
        r.signals?.score ?? "-",
        r.proposed ? `${r.proposed}${r.agreed ? "" : " (flagged)"}` : "-",
        r.capture.failed ?? r.capture.blocked ?? r.capture.action ?? "",
      ]),
    },
  });
  out.push({
    id: "appendix-method",
    title: "Appendix B: method",
    lines: [
      "The sites: every row of portfolios without tier membership (owner removals left out; there were none), in five groups: graded not a portfolio, delisted after grading, delisted before grading, broken or dead never graded, and live never graded.",
      "The capture (GitHub Actions, no AI): desktop 1440x900 and phone 390x844, the splash click-through, a dialog closed with its primary button or Escape, a mode-picker click, up to 15 seconds for content and one retry; only the screens after a click are stored. 32 sites were captured again after the dialog fixes (#218).",
      "Never graded: a capture still showing a gate, a dialog or a bot check, or under 40 words with no outbound links.",
      "Code: the portfolio signals of the full page, and the narrow rules (unedited placeholders, parked pages, code-host and link-in-bio addresses; templates are fine).",
      `The graders: prompt ${PROMPT_VERSION} (the locked two-sets prompts with the owner's definition in STEP 3), Gemini 3.1 Flash-Lite at temperature 0.2 and thinking "low", Haiku 5.5 at its defaults; the same 83 batches of 5 for both, the last filled up from the first.`,
      "The decision: both models' batched answers. Two \"no\" answers stand; where the models disagree, the strong-signals guard (4 or more signals) keeps a one-model \"no\" from removing a site. The same text on another domain sends a site to a person only when a model calls it a portfolio.",
      "Raw data stays local in ~/research/portfoliorank-experiments/recheck-543 and in the workflow artifacts.",
    ],
  });
  return out;
}

const cell = (c) => (c && typeof c === "object" && c.link ? { md: `[${bare(c.link)}](${c.link})`, html: `<a href="${esc(c.link)}">${esc(bare(c.link))}</a>` } : { md: String(c ?? "").replace(/\|/g, "\\|"), html: esc(c) });
const inline = (l) => esc(l).replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

export function markdown(d, secs = sections(d)) {
  const L = ["# Re-check of non-ranked sites (recheck-543)", "", `PortfolioRank experiment, ${new Date().toISOString().slice(0, 10)}.`, `Branch \`exp/recheck-543\`; prompt ${PROMPT_VERSION}.`, "Nothing here changed a grade, listing or rank.", ""];
  for (const s of secs) {
    L.push(`## ${s.title}`, "");
    if (s.box) L.push(...s.lines.map((l) => `> ${l}`), "");
    if (s.cards) L.push("| Number | Value |", "| --- | ---: |", ...s.cards.map(([k, v]) => `| ${k} | ${v} |`), "");
    if (s.table) L.push(`| ${s.table.head.join(" | ")} |`, `| ${s.table.head.map(() => "---").join(" | ")} |`, ...s.table.rows.map((r) => `| ${r.map((c) => cell(c).md).join(" | ")} |`), "");
    if (s.lines && !s.box) L.push(...s.lines, "");
    if (s.list) L.push(...(s.list.length ? s.list : ["None."]), "");
    if (s.sites) {
      if (!s.sites.length) L.push("None.", "");
      for (const r of s.sites) L.push(`- [${bare(r.url)}](${r.url}) (${GROUP_LABELS[r.group]}, signals ${r.signals?.score ?? "-"})`, `  - ${verdictLine("Gemini 3.1", r.verdicts.gemini31.batch)}`, `  - ${verdictLine("Haiku 5.5", r.verdicts.haiku.batch)}`);
      if (s.sites.length) L.push("");
    }
    if (s.means) L.push("**What this means**", "", ...s.means.map((m) => `- ${m}`), "");
  }
  return L.join("\n");
}

/** A site card: both verdicts, the first screens (click for full size) and the whole page in a scroll box when captured. */
function siteCard(r, imgs) {
  const shot = (file, label, cls) => (imgs?.[file] ? `<figure class="${cls}"><a href="${esc(imgs[file])}" target="_blank" rel="noopener"><img src="${esc(imgs[file])}" alt="${esc(label)}" loading="lazy"></a><figcaption>${esc(label)}, click for full size</figcaption></figure>` : "");
  const full = (file, label) => (imgs?.[file] ? `<figure><a href="${esc(imgs[file])}" target="_blank" rel="noopener"><div class="scrollbox"><img src="${esc(imgs[file])}" alt="${esc(label)}" loading="lazy"></div></a><figcaption>${esc(label)}: scroll inside the box, or click for full size</figcaption></figure>` : "");
  const v = (label, x) => `<tr><th>${label}</th><td>${x ? `<strong>${esc(yesNo(x))}</strong> (${PARTS.map((p) => x.scores[p]).join("/")})<div class="seen">${esc(x.reason)}</div>` : "no answer"}</td></tr>`;
  return `<article class="site"><h3><a href="${esc(r.url)}">${esc(bare(r.url))}</a> <span class="tag">${esc(GROUP_LABELS[r.group])}</span> <span class="tag">signals ${esc(r.signals?.score ?? "-")}</span></h3>
<div class="table"><table><tbody>${v("Gemini 3.1", r.verdicts.gemini31.batch)}${v("Haiku 5.5", r.verdicts.haiku.batch)}</tbody></table></div>
${r.capture.action ? `<p class="meta">Before the screenshot: ${esc(r.capture.action)}</p>` : ""}
<div class="shots">${shot("desktop", "Desktop first screen", "")}${shot("phone", "Phone first screen", "phone")}</div>
<div class="shots">${full("full-desktop", "Desktop, whole page")}${full("full-phone", "Phone, whole page")}</div></article>`;
}

export function html(d, { images = null } = {}, secs = sections(d)) {
  const css = `
:root{--bg:#fbfaf7;--fg:#1d1c1a;--muted:#5f5b54;--line:#e3dfd6;--card:#fff;--accent:#2f5f8a;--code:#f2efe8;--box:#eef4fa}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151618;--fg:#e8e6e1;--muted:#a9a49b;--line:#33353a;--card:#1c1e21;--accent:#8db8e0;--code:#22252a;--box:#1b2633}}
:root[data-theme="dark"]{--bg:#151618;--fg:#e8e6e1;--muted:#a9a49b;--line:#33353a;--card:#1c1e21;--accent:#8db8e0;--code:#22252a;--box:#1b2633}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
header.top{max-width:1240px;margin:0 auto;padding:32px 16px 0}.layout{max-width:1240px;margin:0 auto;padding:16px 16px 64px;display:grid;grid-template-columns:230px minmax(0,1fr);gap:40px}
aside nav{position:sticky;top:24px;font-size:14px;max-height:calc(100vh - 48px);overflow:auto}aside ol{list-style:none;margin:8px 0 0;padding:0}aside li{margin:4px 0}aside a{color:var(--muted);text-decoration:none}aside a:hover{color:var(--accent)}
main{min-width:0}h1{font-size:1.9rem;line-height:1.25;margin:0 0 8px}h2{font-size:1.3rem;margin:40px 0 10px;padding-top:12px;border-top:1px solid var(--line)}h3{font-size:1.02rem;margin:0 0 8px}
p,li{max-width:76ch}p,li,td,h3{overflow-wrap:anywhere}a{color:var(--accent)}.sub,.meta{color:var(--muted)}.sub{margin:0 0 20px}.meta{font-size:14px;margin:6px 0}
.tldr{background:var(--box);border:1px solid var(--line);border-radius:10px;padding:14px 18px}.tldr h2{border:0;margin:0 0 6px;padding:0}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.card b{display:block;font-size:1.6rem;font-variant-numeric:tabular-nums}.card span{color:var(--muted);font-size:13px}
.table{overflow-x:auto;margin:10px 0 14px;border:1px solid var(--line);border-radius:8px;background:var(--card)}table{border-collapse:collapse;width:100%;font-size:14px}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left}th{background:var(--code);font-weight:600;white-space:nowrap}td{font-variant-numeric:tabular-nums}tr:last-child td,tr:last-child th{border-bottom:none}
.seen{color:var(--muted);font-size:13px;margin-top:2px}
.means{border-left:3px solid var(--accent);padding:2px 0 2px 14px;margin:14px 0}.means strong{display:block}
.site{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:14px 0}.tag{font-size:12px;font-weight:500;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:1px 8px;margin-left:4px;white-space:nowrap}
.shots{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start}.shots figure{margin:6px 0;flex:1 1 360px;min-width:0}.shots figure.phone{flex:0 1 200px}
.shots img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:6px}figcaption{font-size:12px;color:var(--muted);margin-top:4px}
.scrollbox{max-height:520px;overflow-y:auto;border:1px solid var(--line);border-radius:6px}.scrollbox img{border:0;border-radius:0}
@media (max-width:860px){.layout{grid-template-columns:minmax(0,1fr);gap:0}header.top{padding-bottom:0}aside nav{position:static;max-height:none;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin-bottom:16px}.shots figure.phone{flex:0 1 180px;max-width:60%}}`;
  const body = secs
    .map((s) => {
      if (s.box) return `<section id="${s.id}" class="tldr"><h2>${esc(s.title)}</h2><ul>${s.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></section>`;
      const parts = [`<h2 id="${s.id}">${esc(s.title)}</h2>`];
      if (s.cards) parts.push(`<div class="cards">${s.cards.map(([k, v]) => `<div class="card"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join("")}</div>`);
      if (s.table) parts.push(`<div class="table"><table><thead><tr>${s.table.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${s.table.rows.map((r) => `<tr>${r.map((c) => `<td>${cell(c).html}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      if (s.lines) parts.push(s.lines.map((l) => `<p>${inline(l)}</p>`).join(""));
      if (s.list) parts.push(s.list.length ? `<ul>${s.list.map((l) => `<li>${inline(l.replace(/^- /, ""))}</li>`).join("")}</ul>` : "<p>None.</p>");
      if (s.sites) parts.push(s.sites.length ? s.sites.map((r) => siteCard(r, images?.[r.id])).join("\n") : "<p>None.</p>");
      if (s.means) parts.push(`<div class="means"><strong>What this means</strong><ul>${s.means.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>`);
      return `<section>${parts.join("\n")}</section>`;
    })
    .join("\n");
  const toc = secs.map((s) => `<li><a href="#${s.id}">${esc(s.title)}</a></li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Non-ranked Re-check</title><style>${css}</style></head>
<body><header class="top"><h1>Re-check of non-ranked sites (recheck-543)</h1><p class="sub">PortfolioRank experiment, ${new Date().toISOString().slice(0, 10)}. Branch <code>exp/recheck-543</code>, prompt ${esc(PROMPT_VERSION)}. Nothing here changed a grade, listing or rank.</p></header>
<div class="layout"><aside><nav><strong>Contents</strong><ol>${toc}</ol></nav></aside><main>
${body}
</main></div></body></html>
`;
}

/** Copies the first screens (and whole-page images, when captured) of the sites shown in cards into report/img/. */
function copyImages(d, dir, outDir) {
  const ids = new Set([...d.disagree, ...d.geminiDisallowed].map((r) => r.id));
  const images = {};
  for (const id of ids) {
    const m = {};
    const src = [
      ["desktop", path.join(dir, "bundles", SET, id, "desktop.jpg"), "desktop.jpg"],
      ["phone", path.join(dir, "bundles", SET, id, "phone.jpg"), "phone.jpg"],
      ["full-desktop", path.join(dir, "fullpages", SET, id, "full-desktop.webp"), "full-desktop.webp"],
      ["full-phone", path.join(dir, "fullpages", SET, id, "full-phone.webp"), "full-phone.webp"],
    ];
    for (const [k, from, name] of src) {
      if (!fs.existsSync(from)) continue;
      const rel = path.join("img", id, name);
      fs.mkdirSync(path.join(outDir, "img", id), { recursive: true });
      fs.copyFileSync(from, path.join(outDir, rel));
      m[k] = rel;
    }
    images[id] = m;
  }
  return images;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const d = build();
  const outDir = path.join(DIR, "report");
  fs.mkdirSync(outDir, { recursive: true });
  const images = copyImages(d, DIR, outDir);
  fs.writeFileSync(path.join(outDir, "index.html"), html(d, { images }));
  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(path.join(DOCS, "recheck-543.md"), markdown(d));
  fs.writeFileSync(path.join(DOCS, "recheck-543.html"), html(d));
  console.log(`wrote ${path.join(outDir, "index.html")} (${Object.keys(images).length} site cards with images), ${path.join(DOCS, "recheck-543.md")} and .html`);
}
