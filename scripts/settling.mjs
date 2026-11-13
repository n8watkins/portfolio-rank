#!/usr/bin/env node
// Tiers by ELO, read-only: today's letters on the library and how far it is
// from settled (lib/tiers-settling.mjs). Nothing is written and no AI request
// is made: it reads the grades, the saved check data and the votes, the same
// way the rebuild does (lib/tiers-store.mjs loadGrades).
//
//   node scripts/settling.mjs                 the report as text
//   node scripts/settling.mjs --json          the same as JSON
//   node scripts/settling.mjs --people 100,500,1000,5000 --gemini 400
//                                             the paces to project at (people's votes a day, Gemini calls a day)
//
// Database: Turso when TURSO_DATABASE_URL is set, else the local file.
import path from "node:path";
import { createClient } from "@libsql/client";
import { loadGrades } from "../lib/tiers-store.mjs";
import { SETTLED_FACEOFFS, TIERS, orderLibrary, rankLibrary } from "../lib/tiers.mjs";
import { BATCH_SIZE, daysAt, settlingPlan } from "../lib/tiers-settling.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const peoplePaces = arg("--people", "100,500,1000,5000").split(",").map(Number).filter((x) => x > 0);
const geminiPace = Number(arg("--gemini", "400"));

const url = process.env.TURSO_DATABASE_URL;
const db = url
  ? createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN })
  : createClient({ url: `file:${process.env.LOCAL_DB_FILE ?? path.join(process.cwd(), "data", "portfoliorank.db")}` });

const loaded = await loadGrades(db);
const members = loaded.rows.filter((r) => r.member);
const ranks = rankLibrary(orderLibrary(members.map((r) => r.entry)));
const letters = Object.fromEntries(TIERS.map((t) => [t, 0]));
const points = {};
for (const r of members) {
  const t = ranks.get(r.url).tier;
  letters[t]++;
  const f = t === "SSS" ? "S" : t[0];
  const p = r.points.total;
  points[f] = { min: Math.min(points[f]?.min ?? Infinity, p), max: Math.max(points[f]?.max ?? -Infinity, p) };
}
const plan = settlingPlan(members.map((r) => r.entry.faceoffs));
const report = {
  at: new Date().toISOString(),
  members: members.length,
  letters,
  points,
  plan,
  people: peoplePaces.map((perDay) => ({ perDay, days: daysAt(plan.people, perDay) })),
  gemini: { perDay: geminiPace, oneOnOneDays: daysAt(plan.oneOnOne, geminiPace), batchDays: daysAt(plan.batches, geminiPace) },
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const fmt = (x) => x.toLocaleString("en-US");
  const fam = (f) => TIERS.filter((t) => (t === "SSS" ? "S" : t[0]) === f).reduce((s, t) => s + letters[t], 0);
  console.log(`Library: ${fmt(report.members)} graded portfolios.`);
  for (const f of ["S", "A", "B", "C", "D"]) {
    const range = points[f] ? ` (points ${points[f].min} to ${points[f].max})` : "";
    console.log(`  ${f}: ${fmt(fam(f))}${range}`);
  }
  console.log(`Settled (${SETTLED_FACEOFFS}+ face-offs): ${fmt(plan.settled)} of ${fmt(plan.members)}; ${fmt(plan.missing)} face-offs short in all.`);
  console.log(`Distinct pairs in the library: ${fmt(plan.pairs)}.`);
  console.log(`People's votes needed (at best, two unsettled sites each time): ${fmt(plan.people)}.`);
  for (const p of report.people) console.log(`  at ${fmt(p.perDay)} a day: ${fmt(p.days)} days`);
  console.log(`Gemini one-on-one comparisons needed (each counts ${plan.oneOnOne ? "a quarter" : "nothing"}): ${fmt(plan.oneOnOne ?? 0)}; at ${fmt(geminiPace)} a day: ${fmt(report.gemini.oneOnOneDays)} days.`);
  console.log(`Gemini batches of ${BATCH_SIZE} needed: ${fmt(plan.batches ?? 0)}; at ${fmt(geminiPace)} a day: ${fmt(report.gemini.batchDays)} days.`);
}
