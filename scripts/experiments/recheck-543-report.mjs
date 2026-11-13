#!/usr/bin/env node
// The report of "recheck-543": docs/experiments/recheck-543.md and .html,
// from RECHECK_DIR (results.json from recheck-543-analyze.mjs, the Gemini
// and Haiku state files, the capture meta). The owner's report format: a
// TL;DR box, headline numbers, the verdict table, contents on the side,
// "What this means" under each section, details in appendices. Every
// sentence on its own line in the Markdown. Self-contained HTML, no scripts.
//
//   node scripts/experiments/recheck-543-report.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readJson } from "./grading-two-sets-lib.mjs";
import { DIR, GROUPS, GROUP_LABELS, SET } from "./recheck-543.mjs";

const OUT = path.join(import.meta.dirname, "..", "..", "docs", "experiments");
const PARTS = ["visual_design", "project_presentation", "writing"];
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const bare = (u) => String(u).replace(/^https?:\/\//, "").replace(/\/$/, "");
const read = (p, d = null) => (fs.existsSync(p) ? readJson(p) : d);

/** Agreement between two verdict lists on the sites both answered. */
export function agreement(results, a, b) {
  const both = results.filter((r) => a(r) && b(r));
  const same = both.filter((r) => a(r).is_portfolio === b(r).is_portfolio);
  const cells = { pp: 0, pn: 0, np: 0, nn: 0 };
  for (const r of both) cells[`${a(r).is_portfolio ? "p" : "n"}${b(r).is_portfolio ? "p" : "n"}`]++;
  const scores = Object.fromEntries(
    PARTS.map((p) => {
      const d = both.map((r) => Math.abs(a(r).scores[p] - b(r).scores[p]));
      return [p, { exact: d.filter((x) => x === 0).length, mean: d.length ? d.reduce((s, x) => s + x, 0) / d.length : null }];
    })
  );
  return { n: both.length, same: same.length, cells, scores };
}

/** The request log of a model's state file: requests, answered, status counts, minutes. */
function requestStats(state) {
  if (!state) return null;
  const attempts = state.attempts ?? [];
  const by = {};
  for (const a of attempts) by[a.status] = (by[a.status] ?? 0) + 1;
  const times = attempts.map((a) => Date.parse(a.at)).filter(Number.isFinite);
  const usage = Object.values(state.items ?? {}).map((i) => i.usage).filter(Boolean);
  return {
    http: state.http_requests ?? attempts.length,
    statuses: by,
    busy: Object.entries(by).filter(([s]) => Number(s) >= 500 || s === "0").reduce((n, [, c]) => n + c, 0),
    minutes: times.length ? Math.round((Math.max(...times) - Math.min(...times)) / 60000) : 0,
    cost: state.cost_usd ?? null,
    tokens: usage.length ? { input: usage.reduce((s, u) => s + (u.input_tokens ?? u.promptTokenCount ?? 0), 0), output: usage.reduce((s, u) => s + (u.output_tokens ?? u.candidatesTokenCount ?? 0), 0) } : null,
    stopped: state.stopped ?? state.paused ?? null,
  };
}

export function build(dir = DIR) {
  const results = readJson(path.join(dir, "results.json"));
  const g = requestStats(read(path.join(dir, "gemini31", "state.json")));
  const h = requestStats(read(path.join(dir, "haiku", "state.json")));
  const sel = readJson(path.join(dir, "selection.json"));
  const metas = results.map((r) => read(path.join(dir, "bundles", SET, r.id, "meta.json"))).filter(Boolean);
  const count = (f) => results.filter(f).length;
  const v = (m, k) => (r) => r.verdicts?.[m]?.[k] ?? null;
  const graded = results.filter((r) => r.path === "graders" && r.outcome !== "pending");
  const relistAgreed = count((r) => r.proposed === "relist" && r.agreed);
  const removeAgreed = count((r) => r.proposed === "remove" && r.agreed);
  const flagged = count((r) => r.outcome === "disagree" && r.proposed);
  const review = count((r) => r.proposed === "review");
  const stayOut = count((r) => !r.proposed && r.outcome === "not_portfolio");
  const blocked = count((r) => r.path === "capture_blocked");
  const failed = count((r) => r.path === "capture_failed");
  const pending = count((r) => r.outcome === "pending");
  const ag = {
    batch: agreement(results, v("gemini31", "batch"), v("haiku", "batch")),
    solo: agreement(results, v("gemini31", "solo"), v("haiku", "solo")),
    g31: agreement(results, v("gemini31", "batch"), v("gemini31", "solo")),
    haiku: agreement(results, v("haiku", "batch"), v("haiku", "solo")),
  };
  const capture = {
    sites: results.length,
    ok: count((r) => r.path !== "capture_failed" && r.path !== "capture_blocked"),
    gate: metas.filter((m) => m.gate?.desktop || m.gate?.phone).length,
    modal: metas.filter((m) => m.modal?.desktop || m.modal?.phone).length,
    mode: metas.filter((m) => m.mode_pick?.desktop || m.mode_pick?.phone).length,
    retried: metas.filter((m) => m.retried).length,
    slow: metas.filter((m) => (m.content_wait_ms?.desktop ?? 0) > 3000).length,
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
  const disagree = results.filter((r) => r.outcome === "disagree");
  const bothNot = results.filter((r) => r.verdicts?.gemini31?.batch?.is_portfolio === false && r.verdicts?.haiku?.batch?.is_portfolio === false);
  return { results, sel, g, h, ag, capture, byGroup, disagree, bothNot, graded, numbers: { relistAgreed, removeAgreed, flagged, review, stayOut, blocked, failed, pending } };
}

// ---------------------------------------------------------------- writing

function sections(d) {
  const N = d.numbers;
  const yesNo = (x) => (x == null ? "-" : x ? "portfolio" : "not");
  const linkList = (rows, extra = () => "") => rows.map((r) => `- [${bare(r.url)}](${r.url}) (${GROUP_LABELS[r.group]})${extra(r)}`);
  const agreeLine = (a, label) => (a.n ? `${label}: ${a.same} of ${a.n} agree (${pct(a.same, a.n)}).` : `${label}: no overlap yet.`);
  const out = [];
  out.push({
    id: "tldr",
    title: "TL;DR",
    box: true,
    lines: [
      `We re-checked all ${d.results.length} sites that are not ranked, with a fresh capture, the code rules and two graders: Gemini 3.1 Flash-Lite and Claude Haiku 5.5, with the locked two-set prompts.`,
      `${N.relistAgreed} sites would come back as portfolios where both graders agree, and ${N.removeAgreed} listed sites would leave as not portfolios.`,
      `${N.flagged} sites are flagged because the graders disagree, and ${N.review} need a person (capture blocked or the same text on another domain).`,
      `Nothing has changed on the site: every change waits on the owner's Confirm on /admin/review.`,
      d.g ? `Gemini 3.1 used ${d.g.http} HTTP requests (cap 230)${d.h?.cost != null ? `; Haiku cost $${d.h.cost.toFixed(2)} (cap $3)` : ""}.` : "The graders have not run yet.",
    ],
  });
  out.push({
    id: "numbers",
    title: "Headline numbers",
    cards: [
      ["Sites re-checked", d.results.length],
      ["Would relist (agreed)", N.relistAgreed],
      ["Would remove (agreed)", N.removeAgreed],
      ["Flagged (disagree)", N.flagged],
      ["Needs a person", N.review],
      ["Capture blocked", N.blocked],
      ["Capture failed", N.failed],
      ["Stay out (agreed)", N.stayOut],
    ],
  });
  out.push({
    id: "verdicts",
    title: "Verdicts by group",
    table: {
      head: ["Group", "Sites", "Would relist", "Would remove", "No change", "Flagged", "Needs a person", "Capture failed", ...(N.pending ? ["Waiting"] : [])],
      rows: [
        ...d.byGroup.map((g) => [GROUP_LABELS[g.group], g.n, g.relist, g.remove, g.stay, g.flagged, g.review, g.failed, ...(N.pending ? [g.pending] : [])]),
        ["All", d.results.length, N.relistAgreed, N.removeAgreed, d.byGroup.reduce((s, g) => s + g.stay, 0), N.flagged, N.review, N.failed, ...(N.pending ? [N.pending] : [])],
      ],
    },
    lines: [
      "\"Would relist\" and \"Would remove\" are rows both graders agree on, pre-ticked on the Review page.",
      "\"Flagged\" rows are on the Review page unticked, with both verdicts side by side.",
      "\"No change\" means the verdict matches how the site is shown today.",
      "Delisted sites left the community list in the 2026-11-10 cleanup (#53); their rows say \"no longer on the community list\".",
    ],
    means: [
      "The owner's queue is the relist, remove, flagged and needs-a-person rows; nothing else needs a decision.",
      "A delisted site that is a portfolio is still off the community list; relisting it is a separate choice from its grade.",
    ],
  });
  out.push({
    id: "capture",
    title: "Capture",
    lines: [
      `${d.capture.ok} of ${d.capture.sites} captures were gradable.`,
      `${d.capture.gate} passed a splash gate, ${d.capture.modal} closed a dialog on top of the page, ${d.capture.mode} picked an option on a mode picker, and ${d.capture.retried} needed the one retry.`,
      `${d.capture.slow} took more than 3 seconds to show content on the desktop (up to 15 seconds were allowed).`,
      `${N.blocked} were still blocked after the click-through (a gate, a dialog, a picker, or under 40 words and no outbound links) and went to the queue without any model seeing them.`,
      `${N.failed} failed to load twice and stay as they are.`,
      "Only the screen after the click is stored and graded; the Review page shows what was clicked in one line.",
    ],
    means: [`Blocked captures (${N.blocked}) are the cases a grader would most likely have called "not a portfolio" by mistake; none of them cost a request.`],
  });
  out.push({
    id: "agreement",
    title: "Gemini 3.1 and Haiku agreement",
    table: {
      head: ["", "Haiku: portfolio", "Haiku: not"],
      rows: [
        ["Gemini 3.1: portfolio", d.ag.batch.cells.pp, d.ag.batch.cells.pn],
        ["Gemini 3.1: not", d.ag.batch.cells.np, d.ag.batch.cells.nn],
      ],
    },
    lines: [
      agreeLine(d.ag.batch, "Batched answers (5 sites a request), before the guard"),
      agreeLine(d.ag.solo, "One at a time, on the sites both graded alone"),
      ...PARTS.map((p) => `${p.replace("_", " ")}: same score on ${d.ag.batch.scores[p].exact} of ${d.ag.batch.n}, mean difference ${d.ag.batch.scores[p].mean?.toFixed(2) ?? "-"}.`),
    ],
    means: ["Where they agree, the decision is pre-ticked; the disagreements are the owner's real work."],
  });
  out.push({
    id: "batch-solo",
    title: "Batched against one at a time",
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
  out.push({ id: "disagree", title: `Where the graders disagree (${d.disagree.length})`, lines: linkList(d.disagree, (r) => `: Gemini 3.1 ${yesNo(r.verdicts.gemini31.batch?.is_portfolio)}, Haiku ${yesNo(r.verdicts.haiku.batch?.is_portfolio)}${r.guarded?.gemini31?.guard || r.guarded?.haiku?.guard ? " (guard applied)" : ""}`), list: true });
  out.push({ id: "both-not", title: `Both say not a portfolio (${d.bothNot.length})`, lines: linkList(d.bothNot, (r) => (r.signals?.score >= 4 ? " (strong signals: the guard keeps it a portfolio)" : "")), list: true });
  const reqRow = (name, s, cap) => [name, s ? s.http : 0, cap, s ? s.busy : 0, s ? Object.entries(s.statuses).map(([k, n]) => `${k}: ${n}`).join(", ") : "-", s ? `${s.minutes} min` : "-", s?.cost != null ? `$${s.cost.toFixed(2)}` : "free tier"];
  out.push({
    id: "cost",
    title: "Cost, requests and timing",
    table: { head: ["Grader", "HTTP requests", "Cap", "Busy (5xx or network)", "Statuses", "Wall time", "Cost"], rows: [reqRow("Gemini 3.1 Flash-Lite", d.g, "230"), reqRow("Claude Haiku 5.5", d.h, "$3")] },
    lines: ["Gemini 3.5 was not used at all; production flags and GEMINI_BUDGET were unchanged.", "Every Gemini request is in gemini_requests as job recheck-543."],
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
        `${yesNo(r.verdicts.gemini31.batch?.is_portfolio)} / ${yesNo(r.verdicts.gemini31.solo?.is_portfolio)}`,
        `${yesNo(r.verdicts.haiku.batch?.is_portfolio)} / ${yesNo(r.verdicts.haiku.solo?.is_portfolio)}`,
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
      "The sites: every row of portfolios without tier membership, owner removals left out (there were none), grouped as graded not a portfolio, delisted after grading, delisted before grading, broken or dead never graded, and live never graded.",
      "The capture (GitHub Actions, no AI): desktop 1440x900 and phone 390x844, the splash click-through, a dialog closed with its primary button or Escape, a mode-picker click, up to 15 seconds for content and one retry.",
      "Code: the portfolio signals of the full page, and the narrow placeholder rules (templates are fine; only unedited placeholders count).",
      "The graders: the locked grading-two-sets prompts, unchanged, at temperature 0.2 and thinking \"low\" for Gemini, default effort for Haiku; batches of 5 in a seeded order, the last batch filled from the first.",
      "The decision: Gemini 3.1 batched and Haiku batched, each after the strong-signals guard (4 or more signals keep a site a portfolio).",
      "Raw data stays local in ~/research/portfoliorank-experiments/recheck-543 and in the workflow artifacts.",
    ],
  });
  return out;
}

const cell = (c) => (c && typeof c === "object" && c.link ? { md: `[${bare(c.link)}](${c.link})`, html: `<a href="${esc(c.link)}">${esc(bare(c.link))}</a>` } : { md: String(c ?? "").replace(/\|/g, "\\|"), html: esc(c) });

export function markdown(d, secs = sections(d)) {
  const L = ["# Re-check of non-ranked sites (recheck-543)", "", `PortfolioRank experiment, ${new Date().toISOString().slice(0, 10)}. Branch \`exp/recheck-543\`.`, "Nothing here changed a grade, listing or rank.", ""];
  for (const s of secs) {
    L.push(`## ${s.title}`, "");
    if (s.box) L.push(...s.lines.map((l) => `> ${l}`), "");
    if (s.cards) L.push("| Number | Value |", "| --- | ---: |", ...s.cards.map(([k, v]) => `| ${k} | ${v} |`), "");
    if (s.table) L.push(`| ${s.table.head.join(" | ")} |`, `| ${s.table.head.map(() => "---").join(" | ")} |`, ...s.table.rows.map((r) => `| ${r.map((c) => cell(c).md).join(" | ")} |`), "");
    if (s.lines && !s.box) L.push(...(s.list ? (s.lines.length ? s.lines : ["None."]) : s.lines), "");
    if (s.means) L.push("**What this means**", "", ...s.means.map((m) => `- ${m}`), "");
  }
  return L.join("\n");
}

export function html(d, secs = sections(d)) {
  const css = `
:root{--bg:#fbfaf7;--fg:#1d1c1a;--muted:#5f5b54;--line:#e3dfd6;--card:#fff;--accent:#2f5f8a;--code:#f2efe8;--box:#eef4fa}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151618;--fg:#e8e6e1;--muted:#a9a49b;--line:#33353a;--card:#1c1e21;--accent:#8db8e0;--code:#22252a;--box:#1b2633}}
:root[data-theme="dark"]{--bg:#151618;--fg:#e8e6e1;--muted:#a9a49b;--line:#33353a;--card:#1c1e21;--accent:#8db8e0;--code:#22252a;--box:#1b2633}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.layout{max-width:1240px;margin:0 auto;padding:32px 16px 64px;display:grid;grid-template-columns:220px minmax(0,1fr);gap:40px}
aside nav{position:sticky;top:24px;font-size:14px}aside ol{list-style:none;margin:8px 0 0;padding:0}aside li{margin:4px 0}aside a{color:var(--muted);text-decoration:none}aside a:hover{color:var(--accent)}
main{min-width:0}h1{font-size:1.9rem;line-height:1.25;margin:0 0 8px}h2{font-size:1.3rem;margin:40px 0 10px;padding-top:12px;border-top:1px solid var(--line)}
p,li{max-width:76ch}a{color:var(--accent)}.sub{color:var(--muted);margin:0 0 20px}
.tldr{background:var(--box);border:1px solid var(--line);border-radius:10px;padding:14px 18px}.tldr h2{border:0;margin:0 0 6px;padding:0}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.card b{display:block;font-size:1.6rem;font-variant-numeric:tabular-nums}.card span{color:var(--muted);font-size:13px}
.table{overflow-x:auto;margin:12px 0 18px;border:1px solid var(--line);border-radius:8px;background:var(--card)}table{border-collapse:collapse;width:100%;font-size:14px}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left}th{background:var(--code);font-weight:600;white-space:nowrap}td{font-variant-numeric:tabular-nums}tr:last-child td{border-bottom:none}
.means{border-left:3px solid var(--accent);padding:2px 0 2px 14px;margin:14px 0}.means strong{display:block}
@media (max-width:860px){.layout{grid-template-columns:1fr;gap:0}aside nav{position:static;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin-bottom:16px}}`;
  const body = secs
    .map((s) => {
      const parts = [];
      if (s.box) return `<section id="${s.id}" class="tldr"><h2>${esc(s.title)}</h2><ul>${s.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></section>`;
      parts.push(`<h2 id="${s.id}">${esc(s.title)}</h2>`);
      if (s.cards) parts.push(`<div class="cards">${s.cards.map(([k, v]) => `<div class="card"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join("")}</div>`);
      if (s.table) parts.push(`<div class="table"><table><thead><tr>${s.table.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${s.table.rows.map((r) => `<tr>${r.map((c) => `<td>${cell(c).html}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      if (s.lines) {
        const item = (l) => esc(l).replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
        parts.push(s.list ? (s.lines.length ? `<ul>${s.lines.map((l) => `<li>${item(l.replace(/^- /, ""))}</li>`).join("")}</ul>` : "<p>None.</p>") : s.lines.map((l) => `<p>${item(l)}</p>`).join(""));
      }
      if (s.means) parts.push(`<div class="means"><strong>What this means</strong><ul>${s.means.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>`);
      return `<section>${parts.join("\n")}</section>`;
    })
    .join("\n");
  const toc = secs.map((s) => `<li><a href="#${s.id}">${esc(s.title)}</a></li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Non-ranked Re-check</title><style>${css}</style></head>
<body><div class="layout"><aside><nav><strong>Contents</strong><ol>${toc}</ol></nav></aside><main>
<h1>Re-check of non-ranked sites (recheck-543)</h1><p class="sub">PortfolioRank experiment, ${new Date().toISOString().slice(0, 10)}. Branch <code>exp/recheck-543</code>. Nothing here changed a grade, listing or rank.</p>
${body}
</main></div></body></html>
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const d = build();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "recheck-543.md"), markdown(d));
  fs.writeFileSync(path.join(OUT, "recheck-543.html"), html(d));
  console.log(`wrote ${path.join(OUT, "recheck-543.md")} and .html`);
}
