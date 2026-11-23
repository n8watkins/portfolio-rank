// Rubric v3 (owner, 2026-11-22): "Gemini outputs kept: is_portfolio,
// five-second test, roles. Dropped: the letter, project presentation, visual
// design, writing, memorability." What this covers:
//   - a v3 grade (no letter) is a real Gemini answer everywhere one is read:
//     library membership and rank (lib/tiers-store.mjs), rubric history, the
//     sitemap, the Lighthouse queue, the list's numbers;
//   - the readers of the dropped outputs show and use only the kept three,
//     for old (v2) grades and new ones alike, and nothing is deleted;
//   - the night grader asks v3 and a person's own grade the frozen v2.
// No network, no Gemini key: a stand-in Gemini client and throwaway databases.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { ensureRosterSchema } from "../pipeline/roster.mjs";
import { DROPPED_OUTPUTS, GEMINI_ANSWERED_SQL, RESPONSE_SCHEMA, RUBRIC_VERSION, gradeRecord, keptOutputs, parseRubricResponse } from "../pipeline/rubric.mjs";
import { V2_RESPONSE_SCHEMA } from "../pipeline/rubric-v2.mjs";
import { GEMINI_YES_SQL, geminiYes, libraryMember, rankForWrite, rankFromCode, refreshTiers } from "../lib/tiers-store.mjs";
import { readSiteRow } from "../lib/tiers-db.mjs";
import { gradeKey } from "../lib/grade-score.mjs";
import { parseRubric, replaceGradeStatements } from "../pipeline/rubric-history.mjs";
import { gradedUrls } from "../lib/sitemap-profiles.mjs";
import { lighthouseDue } from "../lib/freshness.mjs";
import { siteStats } from "../lib/games/stats.mjs";
import { printView, renderReportHtml, strengthsAndFixes } from "../lib/grader/report.mjs";
import { geminiReason, doorDecision } from "../lib/reviews/door.mjs";
import { gradeOf } from "../lib/capture-problems.mjs";
import { gradeFromEvidence } from "../pipeline/night.mjs";
import { RUBRIC_V2 } from "../pipeline/rubric-v2.mjs";

const NOW = Date.parse("2026-11-23T12:00:00Z");
const CAPTURED = "2026-11-21 10:00:00";
const ACTIVE = () => "1";

async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-three-"));
  const client = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(client);
  await ensureRosterSchema(client);
  return client;
}

/** A v3 grade as the night stores it, from a parsed answer (the mock writer's shape). */
const v3 = (over = {}, answer = {}) =>
  ({
    ...gradeRecord({
      parsed: parseRubricResponse({
        portfolio_reason: "Shows four web apps the person built",
        is_portfolio: true,
        five_second_test: { score: 4, note: "Name and frontend role are clear" },
        roles: ["frontend developer"],
        ...answer,
      }),
      model: "gemini-3.5-flash-lite",
      facts: null,
      source: "r2",
      now: new Date("2026-11-23T00:00:00Z"),
    }),
    ...over,
  });

/** A v2 grade as stored before v3, with every field it had. */
const v2 = (over = {}) => ({
  is_portfolio: true,
  tier: "S",
  visual_design: { score: 5, note: "polished hero" },
  five_second_test: { score: 3, note: "role is vague" },
  storytelling: { score: 2, note: "bare tech lists" },
  writing: { score: 5, note: "crisp copy" },
  memorability: { score: 5, note: "memorable" },
  roles: ["data engineer"],
  rubric_version: 2,
  quality_score: 4.2,
  checks_score: 70,
  model: "gemini-3.5-flash-lite",
  judged_at: "2026-11-15T00:00:00.000Z",
  ...over,
});

const facts = (n) => {
  const names = ["name", "projects", "about", "contact", "resume", "github"];
  const signals = Object.fromEntries(names.map((k, i) => [k, i < n]));
  return { v: 2, resume: true, github: true, contact: true, own_domain: true, footer_year: 2026, project_links: { checked: 3, ok: 3, broken: 0, blocked: 0 }, signals: { ...signals, score: n }, measured_at: "2026-11-21T10:00:00Z" };
};

test("a v3 grade (no letter) is Gemini's yes for membership; the owner's keep and an error are not", () => {
  const g = v3();
  assert.equal(g.tier, undefined);
  assert.equal(g.rubric_version, RUBRIC_VERSION);
  assert.equal(geminiYes(g), true);
  assert.equal(geminiYes(v3({}, { is_portfolio: false, portfolio_reason: "Sells coaching sessions" })), false);
  assert.equal(geminiYes(v2()), true, "an old grade still counts, by its letter being stored");
  assert.equal(geminiYes({ is_portfolio: true, ai_is_portfolio: false, fresh_grade: "due", source: "owner_review" }), false);
  assert.equal(libraryMember({ listed: true, grade: g }), "gemini");
  assert.equal(libraryMember({ listed: true, goodCapture: true, measured: true, signals: 3, grade: g }), "gemini", "a 3-signal site is ranked on Gemini's v3 yes");
});

test("the SQL forms agree with the code: a v3 row is answered and a yes; an owner keep or an error is neither", async () => {
  const db = await freshDb();
  const rows = [
    ["https://v3.dev", v3()],
    ["https://v3-no.dev", v3({}, { is_portfolio: false })],
    ["https://v2.dev", v2()],
    ["https://keep.dev", { is_portfolio: true, ai_is_portfolio: false, fresh_grade: "due", source: "owner_review" }],
    ["https://err.dev", { error: "no_usable_captures", rubric_version: 3 }],
  ];
  for (const [url, g] of rows) await db.execute({ sql: "INSERT INTO portfolios (url, ai_rubric) VALUES (?, ?)", args: [url, JSON.stringify(g)] });
  // Text that is not JSON never reaches json_extract (an error in SQLite): the SQL is a CASE.
  await db.execute({ sql: "INSERT INTO portfolios (url, ai_rubric) VALUES (?, ?)", args: ["https://broken.dev", "{not json"] });
  const answered = (await db.execute(`SELECT url FROM portfolios p WHERE ${GEMINI_ANSWERED_SQL("p.ai_rubric")} ORDER BY url`)).rows.map((r) => r.url);
  assert.deepEqual(answered, ["https://v2.dev", "https://v3-no.dev", "https://v3.dev"]);
  const yes = (await db.execute(`SELECT url FROM portfolios p WHERE ${GEMINI_YES_SQL("p")} ORDER BY url`)).rows.map((r) => r.url);
  assert.deepEqual(yes, ["https://v2.dev", "https://v3.dev"]);
  for (const [url, g] of rows) assert.equal(yes.includes(url), geminiYes(g), url);
});

test("rank: a v3 yes keeps a code-ranked site exactly where it was; a v3 yes ranks a 3-signal site; a v3 no takes it out", async () => {
  const db = await freshDb();
  await db.batch(
    Array.from({ length: 30 }, (_, i) => ({
      sql: "INSERT INTO portfolios (url, status, shot_key, captured_at, ai_rubric, facts) VALUES (?, 'live', 'k', ?, ?, ?)",
      args: [`https://lib${i}.dev/`, CAPTURED, JSON.stringify(i % 2 ? v2({ tier: ["S", "A", "B", "C", "D"][i % 5] }) : v3()), JSON.stringify(facts(5))],
    })),
    "write"
  );
  await refreshTiers(db, { now: NOW - 86_400_000 });
  // Every member, v2 and v3 alike, is in the library and has its rank copied into its grade.
  for (let i = 0; i < 30; i++) assert.equal((await readSiteRow(db, `https://lib${i}.dev/`)).member, 1, `lib${i}`);
  const stored = JSON.parse(String((await db.execute("SELECT ai_rubric FROM portfolios WHERE url = 'https://lib0.dev/'")).rows[0].ai_rubric));
  assert.ok(stored.rank && stored.rank.seeded, "a v3 grade carries its rank");

  await db.execute({ sql: "INSERT INTO portfolios (url, status, shot_key, captured_at, facts) VALUES (?, 'live', 'k', ?, ?)", args: ["https://coded.dev/", CAPTURED, JSON.stringify(facts(6))] });
  await rankFromCode(db, "https://coded.dev/", { now: NOW });
  const start = await readSiteRow(db, "https://coded.dev/");
  const yes = await rankForWrite(db, v3({}, { five_second_test: { score: 1, note: "unclear" } }), { url: "https://coded.dev/", now: NOW + 1000 });
  const after = await readSiteRow(db, "https://coded.dev/");
  assert.ok(yes.rank && yes.rank.seeded);
  assert.equal(after.mu, start.mu, "a low five-second score moves nothing");
  assert.equal(after.points, start.points);

  await db.execute({ sql: "INSERT INTO portfolios (url, status, shot_key, captured_at, facts) VALUES (?, 'live', 'k', ?, ?)", args: ["https://three.dev/", CAPTURED, JSON.stringify(facts(3))] });
  assert.equal(await rankFromCode(db, "https://three.dev/", { now: NOW }), false);
  const three = await rankForWrite(db, v3(), { url: "https://three.dev/", now: NOW });
  assert.ok(three.rank && three.rank.seeded);
  assert.equal((await readSiteRow(db, "https://three.dev/")).member, 1);

  const no = await rankForWrite(db, v3({}, { is_portfolio: false, portfolio_reason: "A GitHub profile" }), { url: "https://coded.dev/", now: NOW + 2000 });
  assert.equal(no.rank, undefined);
  assert.equal((await readSiteRow(db, "https://coded.dev/")).member, 0);
});

test("the grade key never reads a Gemini output: two grades with the same checks score have the same key", () => {
  assert.equal(gradeKey(v2({ checks_score: 70 })), gradeKey(v3({ checks_score: 70 })));
  assert.equal(gradeKey(v2({ tier: "S", checks_score: 70 })), gradeKey(v2({ tier: "D", quality_score: 1, checks_score: 70 })));
});

test("a v3 grade replaced later moves to rubric_history like any other; nothing is deleted from an old one", () => {
  assert.ok(parseRubric(JSON.stringify(v3())));
  assert.ok(parseRubric(JSON.stringify(v2())));
  assert.equal(parseRubric(JSON.stringify({ is_portfolio: true, fresh_grade: "due", source: "owner_review" })), null);
  const stmts = replaceGradeStatements("https://a.dev", JSON.stringify(v3()), v3(), new Date(NOW));
  assert.ok(stmts.some((s) => /INSERT INTO rubric_history/.test(s.sql)), "the old v3 grade is kept");
  // Reading an old grade through keptOutputs never changes what is stored.
  const old = v2();
  const copy = JSON.stringify(old);
  keptOutputs(old);
  assert.equal(JSON.stringify(old), copy);
});

test("sitemap, Lighthouse queue and the list's numbers count a v3 grade as graded and never read a letter", async () => {
  const db = await freshDb();
  const add = (url, g) => db.execute({ sql: "INSERT INTO portfolios (url, status, ai_rubric) VALUES (?, 'live', ?)", args: [url, JSON.stringify(g)] });
  await add("https://v3.dev", v3());
  await add("https://v2-d.dev", v2({ tier: "D" }));
  await add("https://v3-no.dev", v3({}, { is_portfolio: false }));
  await add("https://keep.dev", { is_portfolio: true, fresh_grade: "due", source: "owner_review" });
  assert.deepEqual([...(await gradedUrls(db))].sort(), ["https://v2-d.dev", "https://v3.dev"]);
  // Lighthouse was S, A and B only by Gemini's letter; now every graded portfolio, a D included.
  assert.deepEqual((await lighthouseDue(db, { now: NOW, limit: 10, active: ACTIVE })).sort(), ["https://v2-d.dev", "https://v3.dev"]);
  const stats = await siteStats(db, { feed: [], now: new Date(NOW) });
  assert.equal(stats.graded, 2);
});

test("the printable report shows the three kept answers, for an old grade too: no letter, no quality, no dropped axis", () => {
  for (const g of [v2(), v3()]) {
    const view = printView(JSON.stringify(g));
    assert.ok(view);
    for (const k of ["tier", "showTier", "quality"]) assert.equal(view[k], undefined, k);
    assert.deepEqual(view.judgments.map((j) => j.id), ["five_second_test"]);
    const html = renderReportHtml({ name: "Ana", url: "https://ana.dev", tagline: null, view, percentiles: null, hero: null, siteUrl: "https://portfoliorank.dev", now: new Date(NOW) });
    assert.match(html, /What Gemini was asked/);
    assert.match(html, /Is it a portfolio\?/);
    assert.match(html, /Five-second test/);
    assert.match(html, /Roles named/);
    for (const word of ["Visual design", "Project presentation", "Writing", "Memorability", "Quality", "polished hero", "crisp copy", ">S<"]) assert.ok(!html.includes(word), word);
  }
  assert.equal(printView(JSON.stringify(v3())).reason, "Shows four web apps the person built");
  assert.equal(printView(JSON.stringify({ is_portfolio: true, fresh_grade: "due" })), null);
});

test("the leaderboard's 'why it's good' reads the kept outputs only: an old grade's 5 for design is never a strength", () => {
  const { strengths, fixes } = strengthsAndFixes(keptOutputs(v2()));
  const ai = [...strengths, ...fixes].filter((x) => x.by === "ai").map((x) => x.criterion);
  assert.deepEqual(ai, ["five_second_test"], "only the five-second test (a 3) is an AI fix");
});

test("the Removal rule's reason and review row read the kept outputs: the portfolio reason first, never a dropped note", () => {
  assert.equal(geminiReason(v3({}, { is_portfolio: false, portfolio_reason: "Sells coaching sessions" })), "Sells coaching sessions; five second test: Name and frontend role are clear.");
  const old = geminiReason(v2({ is_portfolio: false }));
  assert.equal(old, "five second test: role is vague.");
  const d = doorDecision({
    grade: { ...v2({ is_portfolio: false }), facts: { signals: { score: 1 } } },
    row: { url: "https://x.dev", name: "X", page_text: "x", facts: null },
  });
  assert.equal(d.outcome, "remove", "the rule itself is unchanged");
});

test("the capture problems page shows no letter for an old grade", () => {
  assert.deepEqual(gradeOf(JSON.stringify(v2())), { state: "portfolio" });
  assert.deepEqual(gradeOf(JSON.stringify(v3({}, { is_portfolio: false }))), { state: "not_portfolio" });
});

/** A stand-in Gemini client: records the schema it was asked with and answers `answer`. */
const fakeGemini = (answer) => {
  const asked = [];
  return {
    asked,
    generate: async (parts, schema, options) => {
      asked.push({ parts, schema, options });
      return { result: answer, model: "gemini-3.5-flash-lite", usage: { inputTokens: 2000, outputTokens: 60, thoughtsTokens: 0 } };
    },
  };
};
const ROW = { url: "https://ana.dev", name: "Ana", page_text: "Ana, frontend developer. Projects: a weather app.", facts: JSON.stringify(facts(5)), meta: "{}" };

test("the night grader asks v3 and nothing else; a dropped field in the answer is not stored", async () => {
  const g = fakeGemini({ portfolio_reason: "Shows a weather app she built", is_portfolio: true, five_second_test: { score: 5, note: "clear" }, roles: ["frontend developer"], tier: "S", visual_design: { score: 5, note: "x" } });
  const grade = await gradeFromEvidence(g, { row: ROW, image: { inline_data: { mime_type: "image/jpeg", data: "AA" } }, now: new Date(NOW) });
  assert.deepEqual(g.asked[0].schema, RESPONSE_SCHEMA);
  assert.equal(g.asked[0].options.prompt, "grade-v3");
  assert.equal(grade.rubric_version, 3);
  for (const k of DROPPED_OUTPUTS) assert.equal(grade[k], undefined, k);
  assert.equal(grade.portfolio_reason, "Shows a weather app she built");
});

test("a person's own grade (people queue, own key) still asks the frozen v2 prompt, unchanged", async () => {
  const answer = { is_portfolio: true, tier: "B", ...Object.fromEntries(["visual_design", "five_second_test", "storytelling", "writing", "memorability"].map((k) => [k, { score: 3, note: "ok" }])), roles: [] };
  const g = fakeGemini(answer);
  const grade = await gradeFromEvidence(g, { row: ROW, image: { inline_data: { mime_type: "image/jpeg", data: "AA" } }, now: new Date(NOW), rubric: RUBRIC_V2 });
  assert.deepEqual(g.asked[0].schema, V2_RESPONSE_SCHEMA);
  assert.equal(g.asked[0].options.prompt, "grade-v2.1");
  assert.equal(grade.rubric_version, 2);
  assert.equal(grade.tier, "B");
  assert.equal(grade.quality_score, 3);
  // pipeline/people.mjs and lib/grader/own-key.mjs are the two callers of v2.
  assert.match(fs.readFileSync(new URL("../pipeline/people.mjs", import.meta.url), "utf8"), /rubric: RUBRIC_V2/);
  assert.match(fs.readFileSync(new URL("../lib/grader/own-key.mjs", import.meta.url), "utf8"), /from "\.\.\/\.\.\/pipeline\/rubric-v2\.mjs"/);
});
