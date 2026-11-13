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
import { AXES, TIER } from "../grade-pairs.mjs";
import { atLeast, tierOf, tierValue } from "../../lib/tiers.mjs";

// The production address (lib/site.ts PRODUCTION_SITE_URL; tests/site-url.test.mjs keeps them equal).
export const SITE_URL = "https://portfoliorank.dev";
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
  const s = { kind, ready: true, headline, angle, dataAsOf: at, dataLink, facts: [], charts: [], names: [], screenshots: [], notable: [], superlatives: [], examples: [] };
  let n = 0;
  return {
    s,
    fact(label, value, display, { tone = "neutral", about = null, q = query, scope = null } = {}) {
      const id = `f${++n}`;
      s.facts.push({ id, label, value, display: String(display), tone, about, query: q, at, ...(scope ? { scope } : {}) });
      return id;
    },
    /** A surprising fact the writer should lead with: its fact ids and a one-line hook made of placeholders. */
    notable(factIds, why) {
      s.notable.push({ factIds, why });
    },
    /**
     * A claim of "most", "least" or "only" the sheet can support. `tied` is
     * true when more than one item shares the extreme; the checker then
     * rejects a superlative about these facts unless it names the tie.
     */
    superlative(term, factIds, tied, tieFactId) {
      s.superlatives.push({ term, factIds, tied, tieFactId });
    },
    /** A named site that is strong on one axis, for a "Try this" step to point to. */
    example(axis, factId, row) {
      s.examples.push({ axis, factId, name: row.name, url: row.url });
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
    .filter((r) => r.rubric && TIER[r.rubric.tier] && r.rubric.is_portfolio !== false)
    .map((r) => ({ ...r, tier: tierOf(r.rubric) }));
}

/** Tier A or higher: the top 30% by ELO among portfolios with enough face-offs (lib/tiers.mjs). */
const top = (r) => atLeast(r.tier, "A");
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** The items sharing the extreme value of `key`, comparing what a reader sees (rounded to `d` decimals). */
export function extremes(items, key, dir = "max", d = 1) {
  if (!items.length) return [];
  const r = (x) => Number(key(x).toFixed(d));
  const best = (dir === "max" ? Math.max : Math.min)(...items.map(r));
  return items.filter((x) => r(x) === best);
}
const joinWords = (xs) => (xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
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
  if (best.length < MIN_GROUP || rest.length < MIN_GROUP) return notReady(kind, `${best.length} A-or-higher and ${rest.length} other grades; ${MIN_GROUP} of each needed`);
  const b = sheet(kind, {
    now,
    headline: "What the AI grader rewards, and what it marks down",
    angle: "Compare the AI judge's scores on each axis for the top-graded portfolios with the rest: what the grader rewards, where even good portfolios lose points, and the one change a reader can copy.",
    dataLink: `${SITE_URL}/top`,
    query: "portfolios: current AI grades (ai_rubric) of listed, visible portfolios",
  });
  b.fact("Portfolios graded by the AI judge", rows.length, fmt.int(rows.length));
  b.fact("Share of all graded portfolios that are top-graded", best.length / rows.length, fmt.pct(best.length / rows.length), {
    scope: { need: "graded|all portfolios|every portfolio|everyone", avoid: "of (?:the )?(?:top|best|leading) (?:portfolios|sites)" },
  });
  const sCount = rows.filter((r) => r.tier === "SSS").length;
  b.fact("Portfolios with the judge's highest grade, a small part of the top-graded group", sCount, fmt.int(sCount));
  const per = [];
  const bestIds = [];
  const restIds = [];
  for (const k of AXES) {
    const mb = mean(best.map((r) => axisScore(r, k)).filter((x) => x != null));
    const mr = mean(rest.map((r) => axisScore(r, k)).filter((x) => x != null));
    if (mb == null || mr == null) continue;
    const ib = b.fact(`Average ${AXIS_LABELS[k]} score (1 to 5) of the top-graded portfolios`, mb, fmt.dec(mb));
    const ir = b.fact(`Average ${AXIS_LABELS[k]} score (1 to 5) of all other graded portfolios`, mr, fmt.dec(mr));
    bestIds.push([AXIS_LABELS[k], ib]);
    restIds.push([AXIS_LABELS[k], ir]);
    per.push({ k, label: AXIS_LABELS[k], mb, mr, gap: mb - mr, ib, ir });
  }
  if (per.length) {
    const lead = extremes(per, (x) => x.gap, "max");
    const small = extremes(per, (x) => x.gap, "min");
    const leadId = b.fact(lead.length > 1 ? "The axes where the top-graded portfolios lead the rest by the most (tied)" : "The axis where the top-graded portfolios lead the rest by the most", lead.map((x) => x.label).join(" and "), joinWords(lead.map((x) => x.label)));
    const gapId = b.fact("The biggest lead, in points on a 1 to 5 scale", lead[0].gap, `${fmt.dec(lead[0].gap)} points`);
    const nLead = b.fact("Number of axes sharing the biggest lead", lead.length, fmt.int(lead.length));
    b.superlative("biggest lead", [leadId, gapId], lead.length > 1, nLead);
    const smallId = b.fact(small.length > 1 ? "The axes where the gap between the top-graded portfolios and the rest is smallest (tied)" : "The axis where the gap is smallest", small.map((x) => x.label).join(" and "), joinWords(small.map((x) => x.label)));
    b.superlative("smallest gap", [smallId], small.length > 1, nLead);
    // Notable: an axis that is lowest for both groups (a weak spot everywhere), else the smallest gap; then the biggest lead.
    const lowBest = extremes(per, (x) => x.mb, "min");
    const lowRest = extremes(per, (x) => x.mr, "min");
    const lowAll = lowBest.filter((x) => lowRest.includes(x));
    if (lowAll.length === 1) {
      const x = lowAll[0];
      b.superlative("lowest score", [x.ib, x.ir], false, null);
      b.notable([x.ib, x.ir], `${x.label} is the lowest-scoring axis for every group: {{${x.ib}}} on average for the top-graded portfolios against {{${x.ir}}} for the rest`);
    } else {
      b.notable([smallId], `The top-graded portfolios lead the rest by the least on ${small.map((x) => x.label).join(" and ")}`);
    }
    b.notable([leadId, gapId], `the biggest lead of the top-graded portfolios is {{${gapId}}} on {{${leadId}}}${lead.length > 1 ? " (a tie)" : ""}`);
  }
  b.chart({
    title: "Average score by axis: portfolios graded A or higher against the rest",
    unit: "",
    max: 5,
    categories: bestIds.map(([l]) => l),
    series: [
      { name: "Graded A or higher", facts: bestIds.map(([, id]) => id) },
      { name: "Everyone else", facts: restIds.map(([, id]) => id) },
    ],
    alt: "Bar chart of the average AI score per axis, portfolios graded A or higher next to all others; the top group leads on every axis.",
  });
  // Up to 5 SSS sites with a name, highest total first: named only for being graded SSS.
  const named = rows
    .filter((r) => r.tier === "SSS" && r.name)
    .sort((x, y) => axisSum(y) - axisSum(x) || x.url.localeCompare(y.url))
    .slice(0, 5);
  for (const r of named) {
    b.name(r, "has the AI judge's highest grade, one of the top 3");
    b.fact(`${r.name} (${domainOf(r.url)}) has the AI judge's highest grade`, "SSS", "the highest grade", { tone: "positive", about: r.url });
    // What it does well, for the post to say when it links the site: its full-mark axes.
    const strong = per.filter((p) => axisScore(r, p.k) === 5).map((p) => p.label);
    if (strong.length) b.fact(`${r.name} (${domainOf(r.url)}) scores 5 out of 5 on ${joinWords(strong)}`, strong.length, joinWords(strong), { tone: "positive", about: r.url });
  }
  // For each axis, the named SSS site that scores highest on it: a positive example a "Try this" step can link.
  for (const p of per) {
    const strong = named.filter((r) => axisScore(r, p.k) != null).sort((x, y) => axisScore(y, p.k) - axisScore(x, p.k) || x.url.localeCompare(y.url))[0];
    if (strong) b.example(p.label, b.fact(`${strong.name} (${domainOf(strong.url)}) scores ${axisScore(strong, p.k)} out of 5 on ${p.label}`, axisScore(strong, p.k), String(axisScore(strong, p.k)), { tone: "positive", about: strong.url }), strong);
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
  if (best.length < MIN_GROUP || rest.length < MIN_GROUP) return notReady(kind, `${best.length} A-or-higher and ${rest.length} other measured sites; ${MIN_GROUP} of each needed`);
  const b = sheet(kind, {
    now,
    headline: "Dark mode, motion and page weight: what top portfolios actually ship",
    angle: "What the capture measured on each portfolio (dark mode, motion, fitting a phone screen, page weight, console errors), the top-graded portfolios against the rest; aggregate only.",
    dataLink: `${SITE_URL}/top`,
    query: "portfolios: capture measurements (meta) and current AI grades of listed, visible portfolios",
  });
  b.fact("Portfolios measured and graded", rows.length, fmt.int(rows.length));
  b.fact("Of them, top-graded", best.length, fmt.int(best.length));
  // The top group as a share, so a post can call it "the top 23%" rather than by tier letters.
  b.fact("Share of measured portfolios that are top-graded", best.length / rows.length, fmt.pct(best.length / rows.length));
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
    bestIds.push(b.fact(`Share of the top-graded portfolios with ${label}`, sb, fmt.pct(sb)));
    restIds.push(b.fact(`Share of other portfolios with ${label}`, sr, fmt.pct(sr)));
  }
  const mb = (xs) => median(xs.map((r) => r.meta.bytes).filter((x) => typeof x === "number" && x > 0));
  const wb = mb(best);
  const wr = mb(rest);
  if (wb != null && wr != null) {
    b.fact("Median page weight of the top-graded portfolios, first load", wb, `${fmt.dec(wb / 1e6)} MB`);
    b.fact("Median page weight of other portfolios, first load", wr, `${fmt.dec(wr / 1e6)} MB`);
  }
  const rq = (xs) => median(xs.map((r) => r.meta.requests).filter((x) => typeof x === "number" && x > 0));
  const qb = rq(best);
  const qr = rq(rest);
  if (qb != null && qr != null) {
    b.fact("Median number of network requests of the top-graded portfolios", qb, fmt.int(qb));
    b.fact("Median number of network requests of other portfolios", qr, fmt.int(qr));
  }
  // Up to 5 named S sites that fit a phone, load with no console errors and
  // weigh no more than the others' median: positive examples to link, each
  // with what it does well. Named only for those reasons.
  const examples = best
    .filter((r) => atLeast(r.tier, "S-") && r.name && r.meta.overflow390 === false && r.meta.consoleErrors === 0 && typeof r.meta.bytes === "number" && r.meta.bytes > 0 && (wr == null || r.meta.bytes <= wr))
    .sort((x, y) => axisSum(y) - axisSum(x) || x.url.localeCompare(y.url))
    .slice(0, 5);
  for (const r of examples) {
    b.name(r, "has one of the AI judge's highest grades, fits a phone screen and loads light with no console errors");
    const traits = ["fits a phone screen", "no console errors", ...(r.meta.darkMode === true ? ["dark mode by default"] : []), ...(r.meta.motion === true ? ["motion on the page"] : [])];
    b.fact(`${r.name} (${domainOf(r.url)}) has one of the highest grades and ${joinWords(traits)}`, r.tier, "one of the highest grades", { tone: "positive", about: r.url });
    b.fact(`${r.name} (${domainOf(r.url)}) page weight, first load`, r.meta.bytes, `${fmt.dec(r.meta.bytes / 1e6)} MB`, { tone: "positive", about: r.url });
  }
  if (cats.length) {
    b.chart({
      title: "What the capture measured: portfolios graded A or higher against the rest",
      unit: "%",
      max: 1,
      categories: cats,
      series: [
        { name: "Graded A or higher", facts: bestIds },
        { name: "Everyone else", facts: restIds },
      ],
      alt: "Bar chart comparing the share of portfolios graded A or higher and of all others with dark mode, motion, a phone-friendly layout and no console errors.",
    });
  }
  return b.done();
}

// ---------------------------------------------------------------------------
// "What people vote for and against" (people's head-to-head votes)
// ---------------------------------------------------------------------------
/** The traits the capture measures, as [label, test]; undefined when not measured. */
const TRAITS = [
  ["dark mode by default", (r) => (typeof r.meta?.darkMode === "boolean" ? r.meta.darkMode : undefined)],
  ["motion on the page", (r) => (typeof r.meta?.motion === "boolean" ? r.meta.motion : undefined)],
  ["a layout that fits a phone screen", (r) => (typeof r.meta?.overflow390 === "boolean" ? !r.meta.overflow390 : undefined)],
  ["no console errors", (r) => (typeof r.meta?.consoleErrors === "number" ? r.meta.consoleErrors === 0 : undefined)],
];
/** Votes a site needs before its win rate is named. */
export const MIN_VOTES_NAMED = 5;

export async function votePatterns(db, { now }) {
  const kind = "vote-patterns";
  const graded = new Map((await gradedRows(db)).map((r) => [r.url, r]));
  // People's votes only (the AI judge's comparisons live elsewhere), between two graded, visible portfolios.
  const votes = (await db.execute("SELECT winner, loser FROM votes")).rows
    .map((v) => ({ w: graded.get(String(v.winner)), l: graded.get(String(v.loser)) }))
    .filter((v) => v.w && v.l);
  if (votes.length < MIN_GROUP * 2) return notReady(kind, `${votes.length} people's votes between graded portfolios; ${MIN_GROUP * 2} needed`);
  const b = sheet(kind, {
    now,
    headline: "What people vote for when two portfolios go head to head",
    angle: "In people's head-to-head votes, how often the portfolio with the better AI grade wins, and which things the winner has more often (dark mode, motion, a phone-friendly layout, no errors). A reader learns what real visitors reward.",
    dataLink: `${SITE_URL}/top`,
    query: "votes: people's head-to-head votes between two listed, visible, graded portfolios, with the AI grades and capture measurements of both",
  });
  b.fact("People's votes between two graded portfolios", votes.length, fmt.int(votes.length));
  // Tiers by ELO (lib/tiers.mjs), as the site shows them.
  const decided = votes.filter((v) => v.w.tier && v.l.tier && v.w.tier !== v.l.tier);
  if (decided.length >= MIN_GROUP) {
    const agree = decided.filter((v) => tierValue(v.w.tier) > tierValue(v.l.tier)).length;
    const id = b.fact("Share of votes, between portfolios of different AI grades, won by the better-graded one", agree / decided.length, fmt.pct(agree / decided.length), {
      scope: { need: "different (?:AI )?grades?|better-graded|higher-graded", avoid: "of all votes" },
    });
    b.notable([id], `People pick the better-graded portfolio in {{${id}}} of votes where the grades differ.`);
  }
  const cats = [];
  const ids = [];
  for (const [label, f] of TRAITS) {
    // Votes where exactly one side has the trait: who won?
    const split = votes.filter((v) => typeof f(v.w) === "boolean" && typeof f(v.l) === "boolean" && f(v.w) !== f(v.l));
    if (split.length < MIN_GROUP) continue;
    const won = split.filter((v) => f(v.w)).length / split.length;
    cats.push(label);
    ids.push(b.fact(`Share of votes won by the portfolio with ${label}, when only one of the two has it`, won, fmt.pct(won), { scope: { need: "only one|one of the two|when one", avoid: "of all votes" } }));
  }
  if (ids.length) b.chart({ title: "When only one portfolio has it, how often it wins the vote", unit: "%", max: 1, categories: cats, series: [{ name: "Votes won", facts: ids }], alt: "Bar chart of how often the portfolio with each trait wins a vote against one without it." });
  // The portfolios people pick most often (a positive reason), with enough votes to mean something.
  const tally = new Map();
  for (const v of votes) {
    for (const [r, win] of [[v.w, 1], [v.l, 0]]) {
      const t = tally.get(r.url) ?? { row: r, wins: 0, n: 0 };
      t.wins += win;
      t.n += 1;
      tally.set(r.url, t);
    }
  }
  const favourites = [...tally.values()]
    .filter((t) => t.n >= MIN_VOTES_NAMED && t.row.name && t.wins / t.n >= 0.6)
    .sort((x, y) => y.wins / y.n - x.wins / x.n || y.n - x.n || x.row.url.localeCompare(y.row.url))
    .slice(0, 3);
  for (const t of favourites) {
    b.name(t.row, `won most of its head-to-head votes`);
    const id = b.fact(`Share of its head-to-head votes ${t.row.name} (${domainOf(t.row.url)}) won`, t.wins / t.n, fmt.pct(t.wins / t.n), { tone: "positive", about: t.row.url });
    b.example("what voters pick", id, t.row);
  }
  return b.done();
}

// ---------------------------------------------------------------------------
// "How portfolios change: before and after a redesign" (same-rubric re-grades)
// ---------------------------------------------------------------------------
export async function regradeChanges(db, { now }) {
  const kind = "regrade-changes";
  let history;
  try {
    history = (await db.execute("SELECT url, model, rubric, replaced_by_model, replaced_at FROM rubric_history ORDER BY url, id")).rows;
  } catch (e) {
    if (/no such table/i.test(String(e?.message))) return notReady(kind, "no re-grades yet (rubric_history does not exist)");
    throw e;
  }
  const rows = await gradedRows(db);
  const current = new Map(rows.map((r) => [r.url, r]));
  // A site's latest earlier grade by the same model and rubric version as its grade now: the page changed, the judge didn't.
  const pairs = [];
  const seen = new Set();
  for (const h of [...history].reverse()) {
    const url = String(h.url);
    const now2 = current.get(url);
    if (!now2 || seen.has(url)) continue;
    const before = parse(h.rubric);
    if (!before?.tier || !TIER[before.tier] || before.is_portfolio === false) continue;
    if (String(h.model ?? "") !== String(now2.rubric.model ?? "") || (before.rubric_version ?? null) !== (now2.rubric.rubric_version ?? null)) continue;
    seen.add(url);
    // The grade's own letters (Gemini's S to D): the tier by ELO comes from face-offs, not from the grade.
    if (!TIER[now2.rubric.tier]) continue;
    pairs.push({ row: now2, before, after: now2.rubric });
  }
  if (pairs.length < MIN_GROUP) return notReady(kind, `${pairs.length} portfolios re-graded after a change by the same judge; ${MIN_GROUP} needed`);
  const b = sheet(kind, {
    now,
    headline: "Before and after: what changed when portfolios got a better grade",
    angle: "Portfolios whose page changed and were graded again by the same judge with the same rubric: how many moved up a grade letter, which parts of the grade improved most, and what the improvers did. A reader learns which changes pay off.",
    dataLink: `${SITE_URL}/top`,
    query: "rubric_history: each re-graded portfolio's previous grade by the same model and rubric version, against its grade now",
  });
  b.fact("Portfolios re-graded after their page changed", pairs.length, fmt.int(pairs.length));
  const up = pairs.filter((p) => tierValue(p.after.tier) > tierValue(p.before.tier));
  const down = pairs.filter((p) => tierValue(p.after.tier) < tierValue(p.before.tier)).length;
  const upId = b.fact("Share whose grade moved up at least one letter", up.length / pairs.length, fmt.pct(up.length / pairs.length));
  b.fact("Share whose grade moved down at least one letter", down / pairs.length, fmt.pct(down / pairs.length), { tone: "negative" });
  b.notable([upId], `{{${upId}}} of re-graded portfolios moved up a grade letter after a change.`);
  const cats = [];
  const ids = [];
  const gains = [];
  for (const k of AXES) {
    const d = pairs.map((p) => (typeof p.after?.[k]?.score === "number" && typeof p.before?.[k]?.score === "number" ? p.after[k].score - p.before[k].score : null)).filter((x) => x != null);
    if (d.length < MIN_GROUP) continue;
    const m = mean(d);
    gains.push({ k, m });
    cats.push(AXIS_LABELS[k]);
    ids.push(b.fact(`Average change on ${AXIS_LABELS[k]} after a re-grade, in points on a 1 to 5 scale`, m, fmt.dec(m, 2)));
  }
  if (gains.length) {
    const best = extremes(gains, (g) => g.m, "max", 2);
    b.fact(best.length > 1 ? "The parts of the grade that improved most (tied)" : "The part of the grade that improved most", joinWords(best.map((g) => AXIS_LABELS[g.k])), joinWords(best.map((g) => AXIS_LABELS[g.k])));
    b.chart({ title: "Average change per part of the grade after a re-grade (1 to 5 scale)", unit: "", max: 2, categories: cats, series: [{ name: "Average change", facts: ids }], alt: "Bar chart of how much each part of the AI grade changed, on average, when a portfolio was re-graded after a change." });
  }
  for (const p of up.filter((x) => x.row.name).sort((x, y) => tierValue(y.after.tier) - tierValue(x.after.tier) || x.row.url.localeCompare(y.row.url)).slice(0, 3)) {
    b.name(p.row, `grade moved up from ${p.before.tier} to ${p.after.tier} after a redesign`);
    const id = b.fact(`${p.row.name} (${domainOf(p.row.url)}) moved up to tier`, p.after.tier, p.after.tier, { tone: "positive", about: p.row.url });
    b.example("a redesign that paid off", id, p.row);
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
// Owner direction (2026-11-11): every story is about portfolios, never about
// building PortfolioRank. The model comparison (3.1 vs 3.5) and any
// build-in-public, cost or pipeline story are not story kinds.
export const BUILDERS = {
  "top-grades": topGrades,
  "vote-patterns": votePatterns,
  "regrade-changes": regradeChanges,
  "leaderboard-movement": leaderboardMovement,
  "page-craft": pageCraft,
};

/**
 * What each story kind is about, in the owner's words (the "Write a draft now" picker).
 * @type {Record<string, string>}
 */
export const KIND_LABELS = {
  "top-grades": "What the AI grader rewards and penalizes",
  "vote-patterns": "What people vote for and against",
  "regrade-changes": "How portfolios change: before and after",
  "leaderboard-movement": "Trends across the leaderboard",
  "page-craft": "Dark mode, motion, phones and page weight",
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
