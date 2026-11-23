// Scores cached answers. Asks nothing.
//
//   node experiments/two-model-check/score.mjs --set design|heldout --prompt v1 [--arms old,pic,text,full] [--json out.json] [--detail]
import fs from "node:fs";
import {
  LEDGER, MODELS, askable, buildRequest, cacheGet, cacheKey, normalise,
  loadBench, loadSplit, savedPage, stabilitySample,
} from "./common.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);
const set = opt("set");
const prompt = opt("prompt", "v1");
const arms = String(opt("arms", "old,pic,text,full")).split(",");
const detail = has("detail");

const bench = loadBench();
const split = loadSplit();
const byUrl = new Map(bench.sites.map((s) => [s.url, s]));
const urls = set === "design" ? split.design : split.heldout;
const listedByCode = (o) => ["keep", "flag", "unknown"].includes(o);

/** Wilson 95% interval, as percentages. */
function wilson(k, n) {
  if (!n) return "n/a";
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return `${Math.max(0, (c - h) * 100).toFixed(0)}-${Math.min(100, (c + h) * 100).toFixed(0)}%`;
}
const rate = (k, n) => `${k} of ${n} (${n ? ((100 * k) / n).toFixed(0) : "-"}%, 95% CI ${wilson(k, n)})`;

function answersFor(arm, rep = 1) {
  const rows = [];
  for (const url of urls) {
    const site = byUrl.get(url);
    const page = savedPage(site);
    const row = { url, site, label: site.label.class, kind: site.label.kind, outcome: site.outcome, askable: askable(page), a: {} };
    if (row.askable) {
      const req = buildRequest(site, page, { arm, prompt });
      const skip = !req.image && (arm === "old" || arm === "pic");
      for (const [m, model] of Object.entries(MODELS)) {
        if (skip) continue;
        const hit = cacheGet(cacheKey(model, req, rep));
        row.a[m] = hit ? { ...normalise(req.schemaKind, hit.out), usage: hit.usage, usd: hit.usd } : undefined;
      }
    }
    rows.push(row);
  }
  return rows;
}

const short = (a) => (a ? (a.answer === "cannot_tell" ? `cannot tell (${a.why})` : a.answer === "not_portfolio" ? `not (${a.kind ?? "-"})` : "portfolio") : "missing");

const report = { set, prompt, arms: {} };
const out = [];
const p = (s = "") => out.push(s);
p(`# ${set} half, prompt ${prompt}`);

// Code alone on this half.
{
  const all = urls.map((u) => byUrl.get(u));
  const real = all.filter((s) => s.label.class === "real");
  const np = all.filter((s) => s.label.class === "not_portfolio");
  const dead = all.filter((s) => s.label.class === "dead");
  p(`\n## Code alone (${all.length} sites: ${real.length} real, ${np.length} not portfolios, ${dead.length} dead)`);
  p(`- real portfolios hidden or removed: ${rate(real.filter((s) => !listedByCode(s.outcome)).length, real.length)}`);
  p(`- non-portfolios left listed: ${rate(np.filter((s) => listedByCode(s.outcome)).length, np.length)}`);
  p(`- dead sites left listed: ${rate(dead.filter((s) => listedByCode(s.outcome)).length, dead.length)}`);
  report.code = {
    real: real.length, realHidden: real.filter((s) => !listedByCode(s.outcome)).length,
    np: np.length, npListed: np.filter((s) => listedByCode(s.outcome)).length,
    dead: dead.length, deadListed: dead.filter((s) => listedByCode(s.outcome)).length,
  };
}

for (const arm of arms) {
  const rows = answersFor(arm);
  const asked = rows.filter((r) => r.a.gemini || r.a.haiku);
  if (!asked.length) continue;
  const missing = rows.filter((r) => r.askable && (r.a.gemini === undefined || r.a.haiku === undefined) && !(arm === "old" || arm === "pic") ).length;
  p(`\n## Arm ${arm}${missing ? ` (WARNING: ${missing} answers missing)` : ""}`);
  const R = { arm };
  const both = rows.filter((r) => r.a.gemini && r.a.haiku);
  const groups = { real: both.filter((r) => r.label === "real"), np: both.filter((r) => r.label === "not_portfolio"), dead: both.filter((r) => r.label === "dead") };
  p(`Asked: ${both.length} sites with both answers (${groups.real.length} real, ${groups.np.length} not portfolios, ${groups.dead.length} dead).`);
  for (const m of ["gemini", "haiku"]) {
    // --own: each model on every site it answered, not only where both did.
    const mine = (label) => rows.filter((r) => r.a[m] && r.label === label);
    const real = has("own") ? mine("real") : groups.real;
    const np = has("own") ? mine("not_portfolio") : groups.np;
    if (!real.length && !np.length) continue;
    if (has("own")) p(`- ${m} answered ${rows.filter((r) => r.a[m]).length} sites:`);
    const wrongNo = real.filter((r) => r.a[m].answer === "not_portfolio");
    const npMiss = np.filter((r) => r.a[m].answer !== "not_portfolio");
    const npPort = np.filter((r) => r.a[m].answer === "portfolio");
    const realCt = real.filter((r) => r.a[m].answer === "cannot_tell");
    p(`- ${m}: real called not a portfolio ${rate(wrongNo.length, real.length)}; real called cannot tell ${realCt.length}; non-portfolios not called no ${rate(npMiss.length, np.length)} (portfolio ${npPort.length}, cannot tell ${npMiss.length - npPort.length})`);
    const dd = {};
    for (const r of has("own") ? mine("dead") : groups.dead) dd[short(r.a[m])] = (dd[short(r.a[m])] ?? 0) + 1;
    p(`  dead: ${JSON.stringify(dd)}`);
    R[m] = { realNo: wrongNo.length, real: real.length, npMiss: npMiss.length, npPortfolio: npPort.length, np: np.length, realCannot: realCt.length, dead: dd };
  }
  const dn = (r) => r.a.gemini.answer === "not_portfolio" && r.a.haiku.answer === "not_portfolio";
  const realDn = groups.real.filter(dn);
  const npDn = groups.np.filter(dn);
  const deadDn = groups.dead.filter(dn);
  p(`- both say no: real ${rate(realDn.length, groups.real.length)}; non-portfolios ${rate(npDn.length, groups.np.length)}; dead ${deadDn.length} of ${groups.dead.length}`);
  const dis = both.filter((r) => r.a.gemini.answer !== r.a.haiku.answer);
  const disKinds = {};
  for (const r of dis) {
    const k = `${r.label}: gemini ${r.a.gemini.answer} / haiku ${r.a.haiku.answer}`;
    disKinds[k] = (disKinds[k] ?? 0) + 1;
  }
  p(`- the two disagree: ${rate(dis.length, both.length)}: ${JSON.stringify(disKinds)}`);
  R.doubleNo = { real: realDn.length, np: npDn.length, dead: deadDn.length };
  R.disagree = { n: dis.length, of: both.length, kinds: disKinds };

  // The combined system: code first, the check only on what code leaves listed, act on a double no.
  const all = rows;
  const listed = all.filter((r) => listedByCode(r.outcome));
  const removedByCheck = listed.filter((r) => r.a.gemini && r.a.haiku && dn(r));
  const realAll = all.filter((r) => r.label === "real");
  const npAll = all.filter((r) => r.label === "not_portfolio");
  const deadAll = all.filter((r) => r.label === "dead");
  const realGone = realAll.filter((r) => !listedByCode(r.outcome) || removedByCheck.includes(r));
  const npLeft = npAll.filter((r) => listedByCode(r.outcome) && !removedByCheck.includes(r));
  const deadLeft = deadAll.filter((r) => listedByCode(r.outcome) && !removedByCheck.includes(r));
  p(`- COMBINED (code, then the check on what code leaves listed, removal on a double no): real hidden or removed ${rate(realGone.length, realAll.length)}; non-portfolios left listed ${rate(npLeft.length, npAll.length)}; dead left listed ${rate(deadLeft.length, deadAll.length)}`);
  R.combined = { realGone: realGone.length, real: realAll.length, npLeft: npLeft.length, np: npAll.length, deadLeft: deadLeft.length, dead: deadAll.length, checked: listed.filter((r) => r.a.gemini && r.a.haiku).length };
  R.wrongRemovals = realDn.filter((r) => listedByCode(r.outcome)).map((r) => ({ url: r.url, gemini: r.a.gemini.reason, haiku: r.a.haiku.reason }));
  R.npStillListed = npLeft.map((r) => ({ url: r.url, kind: r.kind, outcome: r.outcome, gemini: r.a.gemini ? `${short(r.a.gemini)}: ${r.a.gemini.reason}` : "not asked", haiku: r.a.haiku ? `${short(r.a.haiku)}: ${r.a.haiku.reason}` : "not asked" }));
  R.npRemoved = npAll.filter((r) => removedByCheck.includes(r)).map((r) => r.url);
  R.deadRemoved = deadAll.filter((r) => removedByCheck.includes(r)).map((r) => r.url);
  if (R.wrongRemovals.length) {
    p(`  WRONG double-no removals:`);
    for (const w of R.wrongRemovals) p(`  - ${w.url}\n    gemini: ${w.gemini}\n    haiku: ${w.haiku}`);
  }
  p(`  non-portfolios the combined system still leaves listed:`);
  for (const w of R.npStillListed) p(`  - ${w.url} [${w.kind}; code ${w.outcome}]\n    gemini: ${w.gemini}\n    haiku: ${w.haiku}`);
  p(`  removed by the check: non-portfolios ${R.npRemoved.join(", ") || "none"}; dead ${R.deadRemoved.join(", ") || "none"}`);

  // Cost per site.
  for (const m of ["gemini", "haiku"]) {
    const us = both.map((r) => r.a[m]);
    const tin = us.reduce((s, a) => s + (a.usage?.in ?? 0), 0);
    const tout = us.reduce((s, a) => s + (a.usage?.out ?? 0), 0);
    const usd = us.reduce((s, a) => s + (a.usd ?? 0), 0);
    R[m].tokensIn = tin / us.length;
    R[m].tokensOut = tout / us.length;
    R[m].usdPerSite = usd / us.length;
    p(`- ${m} per site: ${(tin / us.length).toFixed(0)} tokens in, ${(tout / us.length).toFixed(0)} out, $${(usd / us.length).toFixed(5)}`);
  }

  if (detail) {
    p(`  every answer (label | gemini | haiku):`);
    for (const r of both) {
      const flag = (r.label === "real" && (r.a.gemini.answer === "not_portfolio" || r.a.haiku.answer === "not_portfolio")) || (r.label === "not_portfolio" && (r.a.gemini.answer !== "not_portfolio" || r.a.haiku.answer !== "not_portfolio")) || (r.label === "dead" && (r.a.gemini.answer === "portfolio" || r.a.haiku.answer === "portfolio"));
      if (!flag && !has("all")) continue;
      p(`  - ${r.url} [${r.label}${r.kind ? `: ${r.kind}` : ""}; code ${r.outcome}]\n    gemini ${short(r.a.gemini)}: ${r.a.gemini.reason}\n    haiku  ${short(r.a.haiku)}: ${r.a.haiku.reason}`);
    }
  }
  report.arms[arm] = R;
}

// Stability: the 60 fixed held-out sites asked a second time (full arm).
if (set === "heldout") {
  const sample = new Set(stabilitySample(bench, split));
  const r1 = answersFor("full", 1).filter((r) => sample.has(r.url));
  const r2 = answersFor("full", 2).filter((r) => sample.has(r.url));
  const byU2 = new Map(r2.map((r) => [r.url, r]));
  const st = {};
  for (const m of ["gemini", "haiku"]) {
    const pairs = r1.filter((r) => r.a[m] && byU2.get(r.url)?.a[m]);
    const changed = pairs.filter((r) => r.a[m].answer !== byU2.get(r.url).a[m].answer);
    if (!pairs.length) continue;
    st[m] = { pairs: pairs.length, changed: changed.length, which: changed.map((r) => `${r.url} [${r.label}]: ${short(r.a[m])} then ${short(byU2.get(r.url).a[m])}`) };
  }
  const dnPairs = r1.filter((r) => r.a.gemini && r.a.haiku && byU2.get(r.url)?.a.gemini && byU2.get(r.url)?.a.haiku);
  const dn = (x) => x.a.gemini.answer === "not_portfolio" && x.a.haiku.answer === "not_portfolio";
  const dnChanged = dnPairs.filter((r) => dn(r) !== dn(byU2.get(r.url)));
  if (Object.keys(st).length) {
    p(`\n## Stability (full arm, the same request asked twice, ${sample.size} fixed held-out sites)`);
    for (const [m, s] of Object.entries(st)) {
      p(`- ${m}: answer changed on ${rate(s.changed, s.pairs)}`);
      for (const w of s.which) p(`  - ${w}`);
    }
    p(`- the double-no decision changed on ${rate(dnChanged.length, dnPairs.length)}${dnChanged.length ? ": " + dnChanged.map((r) => r.url).join(", ") : ""}`);
    report.stability = { ...st, doubleNoChanged: dnChanged.length, doubleNoPairs: dnPairs.length };
  }
}

// Spend: every HTTP attempt in the ledger, and projections from the full arm's per-site cost.
{
  const lines = fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const by = {};
  for (const e of lines) {
    const b = (by[e.model] ??= { requests: 0, failed: 0, tokensIn: 0, tokensOut: 0, usd: 0 });
    b.requests++;
    if (!e.ok) b.failed++;
    b.tokensIn += e.usage?.in ?? 0;
    b.tokensOut += e.usage?.out ?? 0;
    b.usd += e.usd ?? 0;
  }
  const total = Object.values(by).reduce((s, b) => s + b.usd, 0);
  p(`\n## Spend (the whole experiment so far, from the ledger)`);
  for (const [m, b] of Object.entries(by)) p(`- ${m}: ${b.requests} HTTP requests (${b.failed} failed), ${b.tokensIn} tokens in, ${b.tokensOut} out, $${b.usd.toFixed(4)}`);
  p(`- total $${total.toFixed(4)} over ${lines.length} requests`);
  const f = report.arms.full;
  if (f) {
    const perSite = f.gemini.usdPerSite + f.haiku.usdPerSite;
    p(`- the full request, both models: $${perSite.toFixed(5)} per site; a whole list of 2,150 sites $${(perSite * 2150).toFixed(2)}; 30 new sites a day $${(perSite * 30).toFixed(3)} a day, $${(perSite * 30 * 30).toFixed(2)} a month`);
    report.spend = { by, total, perSite, list2150: perSite * 2150, daily30: perSite * 30 };
  }
}

console.log(out.join("\n"));
if (opt("json")) fs.writeFileSync(opt("json"), JSON.stringify(report, null, 1) + "\n");
