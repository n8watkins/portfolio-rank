// The letter a page, a share image or an email shows, with tiers by ELO
// (RANKING_V2 on; owner rule): the tier comes from ELO and the Gemini grade
// is a report card only, so wherever a grade's letter used to show, the
// site's tier by ELO shows instead, or no letter where Gemini's would mislead.
// Listed sites never show Gemini's letter, flag or not (owner, 2026-11-22):
// with the flag off they show no letter (the home page, the profile); the
// visitor grader ("Grade my portfolio", off) still shows it on its own
// reports until the Gemini letter is retired.
//
//   a listed site        its own tier by ELO (its rating row and the daily cutoffs)
//   a visitor's site     a starting rank from the points its grade shows
//                        (lib/tiers-store.mjs placeGrade), placed in the same cutoffs
//   "not a portfolio"    no letter
import { COLS, peekTierMeta, readSiteRow, readTierMeta, rowOf, standingOf } from "./tiers-db.mjs";
import { placeGrade } from "./tiers-store.mjs";
import { isPublicTier } from "./tiers.mjs";
import { geminiAnswered } from "../pipeline/rubric.mjs";

/**
 * The tier by ELO of a graded report (`result` is the stored grade, `url`
 * the graded address), or null for "not a portfolio" or no grade. `meta` is
 * the daily meta when already read.
 * @param {any} db
 * @param {{ url: string, result: any, meta?: any }} args
 * @returns {Promise<string | null>}
 */
export async function reportTier(db, { url, result, meta = undefined }) {
  // A real Gemini answer of any rubric version (an older grade's letter is never read for this).
  if (!geminiAnswered(result) || result.is_portfolio === false) return null;
  const [m, row] = await Promise.all([meta === undefined ? readTierMeta(db) : meta, url ? readSiteRow(db, url) : null]);
  const rank = placeGrade(result, { meta: m, row: row && !row.fresh ? row : null });
  return rank?.tier ?? null;
}

/**
 * The public tier by ELO of each listed site (SSS to B-; null for a lower
 * one, an ungraded one or one outside the library): one read by key per url
 * and the daily meta.
 * @param {any} db
 * @param {string[]} urls
 * @returns {Promise<Map<string, string | null>>}
 */
export async function publicLetters(db, urls) {
  const out = new Map();
  for (const [url, t] of await siteTiers(db, urls)) out.set(url, isPublicTier(t) ? t : null);
  return out;
}

/**
 * The Tier of each listed site, every letter (SSS to C-, never Gemini's):
 * null for a site outside the library. For choosing sites (the home page's
 * portfolio of the day, a poll's screenshots), not for showing a letter:
 * that is publicLetters. One read by key per url (at most a few hundred) and
 * the daily meta. Before the tier tables exist, every site has none.
 * @param {any} db
 * @param {string[]} urls
 * @returns {Promise<Map<string, string | null>>}
 */
export async function siteTiers(db, urls) {
  const out = new Map();
  const list = [...new Set(urls)];
  if (!list.length) return out;
  // Read only: no schema step on a visitor's request; before the tier tables exist, no site has a Tier.
  const meta = await peekTierMeta(db);
  const rows = new Map();
  try {
    for (let i = 0; i < list.length; i += 100) {
      const part = list.slice(i, i + 100);
      const res = await db.execute({ sql: `SELECT ${COLS} FROM tier_ratings WHERE url IN (${part.map(() => "?").join(",")})`, args: part });
      for (const r of res.rows) rows.set(String(r.url), rowOf(r));
    }
  } catch (e) {
    if (!/no such table/i.test(String(e?.message ?? e))) throw e;
  }
  for (const url of list) {
    const row = rows.get(url);
    out.set(url, row && row.member === 1 ? standingOf(row, meta).tier : null);
  }
  return out;
}

/**
 * A public job (lib/grader/view.mjs publicJob) with its letters by ELO: the
 * report's own tier (null when there is none) and the tiers of the portfolios
 * it points to. `report.eloTiers` marks it, so pages draw the full ladder
 * (SSS, plus and minus). Changes nothing else.
 * @param {any} db
 * @param {any} job
 * @param {any} raw the stored job row (its url and grade)
 */
export async function withEloLetters(db, job, raw) {
  if (!job?.report || !raw?.result) return job;
  const result = typeof raw.result === "string" ? JSON.parse(raw.result) : raw.result;
  const meta = await readTierMeta(db);
  const sites = [...(job.report.similar ?? []), ...(job.report.better ?? []).flatMap((b) => b.sites ?? [])];
  const [tier, letters] = await Promise.all([reportTier(db, { url: String(raw.url ?? job.url), result, meta }), publicLetters(db, sites.map((s) => s.url))]);
  const relabel = (s) => ({ ...s, tier: letters.get(s.url) ?? "" });
  return {
    ...job,
    report: {
      ...job.report,
      tier,
      eloTiers: true,
      similar: (job.report.similar ?? []).map(relabel),
      better: (job.report.better ?? []).map((b) => ({ ...b, sites: (b.sites ?? []).map(relabel) })),
    },
  };
}
