// The content engine's fact builders (docs/CONTENT-ENGINE.md, gate 1 and
// gate 4): plain code, no AI. Each one reads PortfolioRank's own tables and
// returns a fact sheet:
//
//   { kind, ready: true, headline, angle, dataAsOf, dataLink,
//     facts:  [{ id, label, value, display, tone, about, query, at }],
//     charts: [{ id, title, unit, categories, series: [{ name, facts }], alt }],
//     names:  [{ name, url, domain, reason }],   the only sites a post may name
//     screenshots: [{ url, name, shotKey }] }     the only screenshots it may show
//
// or { kind, ready: false, reason } when the data isn't there yet.
//
// The naming rule, enforced here and tested: a fact that is about one site
// (`about` is its URL) is always positive and that site is on `names`;
// names are listed, visible, portfolios their owners haven't removed; a
// negative fact (a drop, a low score) is only ever an aggregate. Gemini
// sees the facts' labels and displays and writes {{id}} placeholders; code
// fills the values in (pipeline/content/writer.mjs), and charts read the
// same facts, so a chart can't disagree with the text.
//
// Page text is never read here: trend facts are counts made by code.
import { ACTIVE, NOT_PORTFOLIO } from "../roster.mjs";
import { HIDDEN_WHERE } from "../../lib/hidden.mjs";
import { ownerRemovals } from "../../lib/games/claims.mjs";
import { AXES, TIER, buildPairs, compareGrades } from "../grade-pairs.mjs";
import { BACKUP_MODEL, PRIMARY_MODEL } from "../gemini.mjs";

export const SITE_URL = "https://portfoliorank.n8builds.dev";
/** The smallest group a share or average is computed over. */
export const MIN_GROUP = 20;
/** Places a site must climb to be named as a climber. */
export const MIN_CLIMB = 3;

export const AXIS_LABELS = {
  visual_design: "visual design",
  five_second_test: "the five-second test",
  storytelling: "project storytelling",
  writing: "writing",
  memorability: "memorability",
  motion: "motion",
};

const nf = new Intl.NumberFormat("en-US");
export const fmt = {
  int: (n) => nf.format(Math.round(n)),
  pct: (x) => `${Math.round(x * 100)}%`,
  dec: (x, d = 1) => x.toFixed(d),
};

export class NamingRuleError extends Error {}

export const domainOf = (url) => {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};

const parse = (v) => {
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
};

/** A small builder for one sheet, which checks the naming rule as it goes. */
function sheet(kind, { now, headline, angle, dataLink, query }) {
  const at = new Date(now).toISOString();
  const s = { kind, ready: true, headline, angle, dataAsOf: at, dataLink, facts: [], charts: [], names: [], screenshots: [] };
  let n = 0;
  return {
    s,
    fact(label, value, display, { tone = "neutral", about = null, q = query } = {}) {
      const id = `f${++n}`;
      s.facts.push({ id, label, value, display: String(display), tone, about, query: q, at });
      return id;
    },
    name(row, reason) {
      if (!s.names.some((x) => x.url === row.url)) {
        s.names.push({ name: row.name, url: row.url, domain: domainOf(row.url), reason });
        if (row.shotKey) s.screenshots.push({ url: row.url, name: row.name, shotKey: row.shotKey });
      }
    },
    chart(spec) {
      s.charts.push({ id: `c${s.charts.length + 1}`, ...spec });
    },
    done() {
      return assertNamingRule(s);
    },
  };
}

/**
 * Throws NamingRuleError unless the sheet keeps the naming rule: every fact
 * about one site is positive and names a listed site; every name and
 * screenshot is on the list of positive names. Returns the sheet.
 */
export function assertNamingRule(s) {
  const named = new Set(s.names.map((x) => x.url));
  for (const f of s.facts) {
    if (f.about == null) continue;
    if (f.tone !== "positive") throw new NamingRuleError(`${s.kind}: fact ${f.id} names ${f.about} with a ${f.tone} fact`);
    if (!named.has(f.about)) throw new NamingRuleError(`${s.kind}: fact ${f.id} is about ${f.about}, which is not on the names list`);
  }
  for (const x of s.names) if (!x.reason) throw new NamingRuleError(`${s.kind}: ${x.url} is named without a positive reason`);
  for (const x of s.screenshots) if (!named.has(x.url)) throw new NamingRuleError(`${s.kind}: screenshot of ${x.url}, which is not named`);
  return s;
}

const notReady = (kind, reason) => ({ kind, ready: false, reason });

/** URLs a post may never name: removed by their owners. */
async function removedUrls(db) {
  return new Set((await ownerRemovals(db)).map((r) => r.url));
}

/** Listed, visible, real portfolios (the only ones that may be named). */
const VISIBLE = `p.status = 'live' AND ${ACTIVE("p")} AND NOT (${HIDDEN_WHERE}) AND NOT ${NOT_PORTFOLIO("p")}`;

async function gradedRows(db) {
  const removed = await removedUrls(db);
  const rows = (
    await db.execute(
      `SELECT p.url, p.name, p.shot_key, p.ai_rubric, p.meta FROM portfolios p
       WHERE ${VISIBLE} AND json_valid(p.ai_rubric) AND json_extract(p.ai_rubric, '$.tier') IS NOT NULL
         AND json_extract(p.ai_rubric, '$.error') IS NULL ORDER BY p.url`
    )
  ).rows;
  return rows
    .filter((r) => !removed.has(String(r.url)))
    .map((r) => ({ url: String(r.url), name: r.name == null ? null : String(r.name), shotKey: r.shot_key == null ? null : String(r.shot_key), rubric: parse(r.ai_rubric), meta: parse(r.meta) }))
    .filter((r) => r.rubric && TIER[r.rubric.tier] && r.rubric.is_portfolio !== false);
}

const top = (r) => r.rubric.tier === "S" || r.rubric.tier === "A";
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const axisScore = (r, k) => (typeof r.rubric?.[k]?.score === "number" ? r.rubric[k].score : null);
const axisSum = (r) => AXES.reduce((a, k) => a + (axisScore(r, k) ?? 0), 0);

// ---------------------------------------------------------------------------
// "What the best-graded portfolios share" (grades: ready now)
// ---------------------------------------------------------------------------
export async function topGrades(db, { now }) {
  const kind = "top-grades";
  const rows = await gradedRows(db);
  const best = rows.filter(top);
  const rest = rows.filter((r) => !top(r));
  if (best.length < MIN_GROUP || rest.length < MIN_GROUP) return notReady(kind, `${best.length} S/A and ${rest.length} other grades; ${MIN_GROUP} of each needed`);
  const b = sheet(kind, {
    now,
    headline: "What the best-graded developer portfolios have in common",
    angle: "Compare the AI judge's scores on each axis for portfolios graded S or A with the rest, and say what a reader can copy.",
    dataLink: `${SITE_URL}/top`,
    query: "portfolios: current AI grades (ai_rubric) of listed, visible portfolios",
  });
  b.fact("Portfolios graded by the AI judge", rows.length, fmt.int(rows.length));
  b.fact("Share graded S or A", best.length / rows.length, fmt.pct(best.length / rows.length));
  const sCount = rows.filter((r) => r.rubric.tier === "S").length;
  b.fact("Portfolios graded S, the top tier", sCount, fmt.int(sCount));
  const gaps = [];
  const bestIds = [];
  const restIds = [];
  for (const k of AXES) {
    const mb = mean(best.map((r) => axisScore(r, k)).filter((x) => x != null));
    const mr = mean(rest.map((r) => axisScore(r, k)).filter((x) => x != null));
    if (mb == null || mr == null) continue;
    bestIds.push([AXIS_LABELS[k], b.fact(`Average ${AXIS_LABELS[k]} score (1 to 5) of S and A portfolios`, mb, fmt.dec(mb))]);
    restIds.push([AXIS_LABELS[k], b.fact(`Average ${AXIS_LABELS[k]} score (1 to 5) of all other graded portfolios`, mr, fmt.dec(mr))]);
    gaps.push({ k, gap: mb - mr });
  }
  gaps.sort((x, y) => y.gap - x.gap);
  if (gaps.length) {
    b.fact("The axis where S and A portfolios lead the rest by the most", AXIS_LABELS[gaps[0].k], AXIS_LABELS[gaps[0].k]);
    b.fact("That axis's lead, in points on a 1 to 5 scale", gaps[0].gap, `${fmt.dec(gaps[0].gap)} points`);
    const last = gaps.at(-1);
    b.fact("The axis where the gap is smallest", AXIS_LABELS[last.k], AXIS_LABELS[last.k]);
  }
  b.chart({
    title: "Average score by axis: S and A portfolios against the rest",
    unit: "",
    max: 5,
    categories: bestIds.map(([l]) => l),
    series: [
      { name: "Graded S or A", facts: bestIds.map(([, id]) => id) },
      { name: "Everyone else", facts: restIds.map(([, id]) => id) },
    ],
    alt: "Bar chart of the average AI score per axis, S and A portfolios next to all others; the top group leads on every axis.",
  });
  // Up to 5 S-tier sites with a name, highest total first: named only for being graded S.
  const named = rows
    .filter((r) => r.rubric.tier === "S" && r.name)
    .sort((x, y) => axisSum(y) - axisSum(x) || x.url.localeCompare(y.url))
    .slice(0, 5);
  for (const r of named) {
    b.name(r, "graded S by the AI judge");
    b.fact(`${r.name} (${domainOf(r.url)}) is graded`, "S", "S", { tone: "positive", about: r.url });
  }
  return b.done();
}

// ---------------------------------------------------------------------------
// "Dark mode, motion and page weight" (measured by the capture: ready now)
// ---------------------------------------------------------------------------
export async function pageCraft(db, { now }) {
  const kind = "page-craft";
  const rows = (await gradedRows(db)).filter((r) => r.meta && typeof r.meta === "object");
  const best = rows.filter(top);
  const rest = rows.filter((r) => !top(r));
  if (best.length < MIN_GROUP || rest.length < MIN_GROUP) return notReady(kind, `${best.length} S/A and ${rest.length} other measured sites; ${MIN_GROUP} of each needed`);
  const b = sheet(kind, {
    now,
    headline: "Dark mode, motion and page weight: what top portfolios actually ship",
    angle: "What the capture measured on each portfolio (dark mode, motion, fitting a phone screen, page weight, console errors), S and A portfolios against the rest; aggregate only.",
    dataLink: `${SITE_URL}/top`,
    query: "portfolios: capture measurements (meta) and current AI grades of listed, visible portfolios",
  });
  b.fact("Portfolios measured and graded", rows.length, fmt.int(rows.length));
  b.fact("Of them, graded S or A", best.length, fmt.int(best.length));
  const share = (xs, f) => {
    const known = xs.filter((r) => typeof f(r) === "boolean");
    return known.length ? known.filter(f).length / known.length : null;
  };
  const measures = [
    ["dark mode by default", (r) => (typeof r.meta.darkMode === "boolean" ? r.meta.darkMode : undefined)],
    ["motion on the page", (r) => (typeof r.meta.motion === "boolean" ? r.meta.motion : undefined)],
    ["fits a phone screen without sideways scrolling", (r) => (typeof r.meta.overflow390 === "boolean" ? !r.meta.overflow390 : undefined)],
    ["no console errors", (r) => (typeof r.meta.consoleErrors === "number" ? r.meta.consoleErrors === 0 : undefined)],
  ];
  const cats = [];
  const bestIds = [];
  const restIds = [];
  for (const [label, f] of measures) {
    const sb = share(best, f);
    const sr = share(rest, f);
    if (sb == null || sr == null) continue;
    cats.push(label);
    bestIds.push(b.fact(`Share of S and A portfolios with ${label}`, sb, fmt.pct(sb)));
    restIds.push(b.fact(`Share of other portfolios with ${label}`, sr, fmt.pct(sr)));
  }
  const mb = (xs) => median(xs.map((r) => r.meta.bytes).filter((x) => typeof x === "number" && x > 0));
  const wb = mb(best);
  const wr = mb(rest);
  if (wb != null && wr != null) {
    b.fact("Median page weight of S and A portfolios, first load", wb, `${fmt.dec(wb / 1e6)} MB`);
    b.fact("Median page weight of other portfolios, first load", wr, `${fmt.dec(wr / 1e6)} MB`);
  }
  const rq = (xs) => median(xs.map((r) => r.meta.requests).filter((x) => typeof x === "number" && x > 0));
  const qb = rq(best);
  const qr = rq(rest);
  if (qb != null && qr != null) {
    b.fact("Median number of network requests of S and A portfolios", qb, fmt.int(qb));
    b.fact("Median number of network requests of other portfolios", qr, fmt.int(qr));
  }
  if (cats.length) {
    b.chart({
      title: "What the capture measured: S and A portfolios against the rest",
      unit: "%",
      max: 1,
      categories: cats,
      series: [
        { name: "Graded S or A", facts: bestIds },
        { name: "Everyone else", facts: restIds },
      ],
      alt: "Bar chart comparing the share of S and A portfolios and of all others with dark mode, motion, a phone-friendly layout and no console errors.",
    });
  }
  return b.done();
}

// ---------------------------------------------------------------------------
// "3.1 vs 3.5: do they grade the same?" (re-grade pairs in rubric_history)
// ---------------------------------------------------------------------------
export async function modelCompare(db, { now, from = BACKUP_MODEL, to = PRIMARY_MODEL }) {
  const kind = "model-compare";
  let history;
  try {
    history = (await db.execute("SELECT url, model, rubric, replaced_by_model FROM rubric_history ORDER BY url, id")).rows.map((r) => ({
      url: String(r.url),
      model: r.model == null ? null : String(r.model),
      rubric: String(r.rubric),
      replaced_by_model: r.replaced_by_model == null ? null : String(r.replaced_by_model),
    }));
  } catch (e) {
    if (/no such table/i.test(String(e?.message))) return notReady(kind, "no re-grades yet (rubric_history does not exist)");
    throw e;
  }
  const rows = await gradedRows(db);
  const visible = new Map(rows.map((r) => [r.url, r]));
  const current = new Map(
    (await db.execute(`SELECT url, ai_rubric FROM portfolios WHERE url IN (SELECT DISTINCT url FROM rubric_history)`)).rows.map((r) => [String(r.url), r.ai_rubric == null ? null : String(r.ai_rubric)])
  );
  const pairs = buildPairs(history, current, { from, to });
  if (pairs.length < MIN_GROUP) return notReady(kind, `${pairs.length} sites graded by both models; ${MIN_GROUP} needed`);
  const r = compareGrades(pairs);
  const b = sheet(kind, {
    now,
    headline: "We re-graded the same portfolios with a newer Gemini. Do the grades hold?",
    angle: `The same sites graded by ${from} and then ${to} with the same rubric: how often the tier matched, which axes moved most, and what that means for anyone reading an AI grade.`,
    dataLink: `${SITE_URL}/top`,
    query: "rubric_history: each site's grade by the older model, paired with the newer model's grade of the same site and rubric version",
  });
  b.fact("Sites graded by both models", r.pairs, fmt.int(r.pairs));
  b.fact("Share given exactly the same tier", r.exact / r.pairs, fmt.pct(r.exact / r.pairs));
  b.fact("Share within one tier", r.withinOne / r.pairs, fmt.pct(r.withinOne / r.pairs));
  const higher = pairs.filter((p) => TIER[p.b.tier] > TIER[p.a.tier]).length;
  const lower = pairs.filter((p) => TIER[p.b.tier] < TIER[p.a.tier]).length;
  b.fact("Share the newer model graded higher", higher / r.pairs, fmt.pct(higher / r.pairs));
  b.fact("Share the newer model graded lower", lower / r.pairs, fmt.pct(lower / r.pairs));
  const maeIds = [];
  const cats = [];
  for (const k of AXES) {
    if (r.mae[k] == null) continue;
    cats.push(AXIS_LABELS[k]);
    maeIds.push(b.fact(`Average difference on ${AXIS_LABELS[k]}, in points on a 1 to 5 scale`, r.mae[k], fmt.dec(r.mae[k], 2)));
  }
  const ranked = AXES.filter((k) => r.mae[k] != null).sort((x, y) => r.mae[y] - r.mae[x]);
  if (ranked.length) {
    b.fact("The axis the models disagree on most", AXIS_LABELS[ranked[0]], AXIS_LABELS[ranked[0]]);
    b.fact("The axis the models agree on most", AXIS_LABELS[ranked.at(-1)], AXIS_LABELS[ranked.at(-1)]);
  }
  if (cats.length) {
    b.chart({ title: "Average difference per axis between the two models (1 to 5 scale)", unit: "", max: 2, categories: cats, series: [{ name: "Average difference", facts: maeIds }], alt: "Bar chart of how far apart the two models' scores are on each axis, on average." });
  }
  const tiers = ["S", "A", "B", "C", "D"];
  const dist = (side) => tiers.map((t) => pairs.filter((p) => p[side].tier === t).length / r.pairs);
  const da = dist("a");
  const db2 = dist("b");
  b.chart({
    title: "Tier shares of the same sites under each model",
    unit: "%",
    max: 1,
    categories: tiers,
    series: [
      { name: from, facts: tiers.map((t, i) => b.fact(`Share graded ${t} by ${from}`, da[i], fmt.pct(da[i]))) },
      { name: to, facts: tiers.map((t, i) => b.fact(`Share graded ${t} by ${to}`, db2[i], fmt.pct(db2[i]))) },
    ],
    alt: "Grouped bar chart of the share of sites in each tier under the older and the newer model.",
  });
  const bothS = pairs.filter((p) => p.a.tier === "S" && p.b.tier === "S" && visible.get(p.url)?.name).slice(0, 5);
  for (const p of bothS) {
    const row = visible.get(p.url);
    b.name(row, "graded S by both models");
    b.fact(`${row.name} (${domainOf(row.url)}) was graded S by both models`, "S", "S", { tone: "positive", about: row.url });
  }
  return b.done();
}

// ---------------------------------------------------------------------------
// "Leaderboard movement" (ranking v2's weekly snapshots)
// ---------------------------------------------------------------------------
export async function leaderboardMovement(db, { now, view = "merged" }) {
  const kind = "leaderboard-movement";
  let weeks;
  try {
    weeks = (await db.execute({ sql: "SELECT DISTINCT week FROM rank_history WHERE view = ? ORDER BY week DESC LIMIT 2", args: [view] })).rows.map((r) => String(r.week));
  } catch (e) {
    if (/no such table/i.test(String(e?.message))) return notReady(kind, "ranking v2 has no weekly snapshots yet (rank_history does not exist)");
    throw e;
  }
  if (weeks.length < 2) return notReady(kind, `${weeks.length} weekly snapshot(s); 2 needed`);
  const removed = await removedUrls(db);
  const visible = new Map(
    (await db.execute(`SELECT p.url, p.name, p.shot_key FROM portfolios p WHERE ${VISIBLE}`)).rows
      .filter((r) => !removed.has(String(r.url)))
      .map((r) => [String(r.url), { url: String(r.url), name: r.name == null ? null : String(r.name), shotKey: r.shot_key == null ? null : String(r.shot_key) }])
  );
  // Ranks among the sites the board shows, so a hidden site never counts as a place.
  const board = async (week) => {
    const rows = (await db.execute({ sql: "SELECT url, rank FROM rank_history WHERE view = ? AND week = ? ORDER BY rank, url", args: [view, week] })).rows.filter((r) => visible.has(String(r.url)));
    return new Map(rows.map((r, i) => [String(r.url), i + 1]));
  };
  const [latest, previous] = [await board(weeks[0]), await board(weeks[1])];
  const both = [...latest.keys()].filter((u) => previous.has(u));
  if (both.length < MIN_GROUP) return notReady(kind, `${both.length} sites ranked in both weeks; ${MIN_GROUP} needed`);
  const b = sheet(kind, {
    now,
    headline: "Who climbed the PortfolioRank leaderboard this week",
    angle: "The week's biggest climbers and the top of the board, with what their portfolios do well; drops only as a count.",
    dataLink: `${SITE_URL}/top`,
    query: `rank_history (view ${view}): weeks ${weeks[1]} and ${weeks[0]}, ranks among visible portfolios`,
  });
  b.fact("Portfolios on the board this week", latest.size, fmt.int(latest.size));
  const moves = both.map((u) => ({ url: u, gain: previous.get(u) - latest.get(u) }));
  const up = moves.filter((m) => m.gain > 0).length;
  const down = moves.filter((m) => m.gain < 0).length;
  b.fact("Portfolios that moved up", up, fmt.int(up));
  b.fact("Portfolios that moved down", down, fmt.int(down), { tone: "negative" });
  const newTop10 = [...latest.entries()].filter(([u, r]) => r <= 10 && !(previous.get(u) <= 10)).length;
  b.fact("New entries in the top 10", newTop10, fmt.int(newTop10));
  const leaders = [...latest.entries()].sort((x, y) => x[1] - y[1]).slice(0, 3);
  for (const [u, r] of leaders) {
    const row = visible.get(u);
    if (!row?.name) continue;
    b.name(row, `number ${r} on the leaderboard`);
    b.fact(`${row.name} (${domainOf(u)}) is at number`, r, `#${r}`, { tone: "positive", about: u });
  }
  const climbers = moves
    .filter((m) => m.gain >= MIN_CLIMB && visible.get(m.url)?.name)
    .sort((x, y) => y.gain - x.gain || x.url.localeCompare(y.url))
    .slice(0, 5);
  const ids = [];
  for (const m of climbers) {
    const row = visible.get(m.url);
    b.name(row, `climbed ${m.gain} places this week`);
    ids.push(b.fact(`${row.name} (${domainOf(m.url)}) climbed, in places`, m.gain, fmt.int(m.gain), { tone: "positive", about: m.url }));
    b.fact(`${row.name}'s rank this week`, latest.get(m.url), `#${latest.get(m.url)}`, { tone: "positive", about: m.url });
  }
  if (ids.length) {
    b.chart({ title: "This week's biggest climbers, places gained", unit: "", categories: climbers.map((m) => visible.get(m.url).name), series: [{ name: "Places gained", facts: ids }], alt: "Bar chart of the places each of this week's biggest climbers gained." });
  }
  return b.done();
}

/** Every fact builder, by story kind. */
export const BUILDERS = {
  "model-compare": modelCompare,
  "leaderboard-movement": leaderboardMovement,
  "top-grades": topGrades,
  "page-craft": pageCraft,
};

/** Story ideas from the data (stage 1, Find): every builder that is ready. */
export async function findIdeas(db, { now }) {
  const ideas = [];
  const waiting = [];
  for (const [kind, build] of Object.entries(BUILDERS)) {
    const s = await build(db, { now });
    if (s.ready) ideas.push({ kind, headline: s.headline, angle: s.angle, facts: s.facts.length });
    else waiting.push({ kind, reason: s.reason });
  }
  return { ideas, waiting };
}
