#!/usr/bin/env node
// Phase 1 AI bootstrap (GRADING_CRITERIA.md §6): Gemini Flash judges captured
// portfolios.
//
//   rubric   — 1 call/site: settled hero + motion frame + full-page shot →
//              tier + six 1–5 axis scores + one-line justifications, stored as
//              JSON in portfolios.ai_rubric (shown in UI later).
//   pairwise — 1 call = 2 sites: "which is better overall?" on hero shots →
//              a vote in the `votes` table (rater_type='ai') that moves ELO,
//              same math and pair_key convention as human votes.
//
// Usage:
//   node pipeline/judge.mjs rubric   [--limit N] [--only substr] [--force] [--rpm R] [--model M]
//   node pipeline/judge.mjs pairwise [--votes N] [--rpm R] [--model M]
//
// Budget: the free tier allows ~500 requests/day; every call is logged so you
// can see what a run spent. Rate is paced to --rpm (default 8) to stay under
// the free-tier requests-per-minute cap.
import { createClient } from "@libsql/client";
import fs from "fs";
import path from "path";

const ROOT = path.join(import.meta.dirname, "..");

// Optional: in CI (GitHub Actions) there's no .env.local — vars come from the
// runner env/secrets instead.
if (fs.existsSync(path.join(ROOT, ".env.local"))) {
  for (const line of fs
    .readFileSync(path.join(ROOT, ".env.local"), "utf8")
    .split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY missing from .env.local");
  process.exit(1);
}

const args = process.argv.slice(2);
const MODE = args[0];
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
// flash-lite has the biggest free-tier daily budget; --model swaps in a
// stronger judge. rater_id carries the model so votes stay per-model tagged.
const MODEL = flag("model", "gemini-3.1-flash-lite");
const RATER_ID = `ai:${MODEL}`;
const LIMIT = Number(flag("limit", "0")) || Infinity;
const VOTES = Number(flag("votes", "20"));
const ONLY = flag("only", "");
const FORCE = args.includes("--force");
const RPM = Number(flag("rpm", "8"));

const db = process.env.TURSO_DATABASE_URL
  ? createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    })
  : createClient({ url: `file:${path.join(ROOT, "data", "portfoliorank.db")}` });

// Same direction-independent key as lib/elo.ts pairKey() — "\n" separator on
// purpose (can't appear in a URL; NUL would be truncated by SQLite).
const pairKey = (a, b) => [a, b].sort().join("\n");
const BASE_ELO = 1200;
function eloUpdate(winnerElo, loserElo, k = 32) {
  const expectedWin = 1 / (1 + 10 ** ((loserElo - winnerElo) / 400));
  const gain = k * (1 - expectedWin);
  return {
    winner: Math.round(winnerElo + gain),
    loser: Math.round(loserElo - gain),
  };
}

// ---------------------------------------------------------------------------
// Gemini REST client: JSON-mode generateContent with pacing + retry
// ---------------------------------------------------------------------------
let calls = 0;
let lastCall = 0;
async function gemini(parts, schema) {
  const gap = Math.ceil(60000 / RPM);
  const wait = lastCall + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  calls++;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
            responseSchema: schema,
          },
        }),
        signal: AbortSignal.timeout(120000),
      }
    );
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const delay = 15000 * (attempt + 1);
      console.log(`  gemini ${res.status}, retrying in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    if (!res.ok)
      throw new Error(`gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error(`gemini empty response: ${JSON.stringify(data).slice(0, 300)}`);
    return JSON.parse(text);
  }
}

// Inline image part; skips files that would blow the request size cap.
function imagePart(file, budgetBytes = 5 * 1024 * 1024) {
  if (!fs.existsSync(file) || fs.statSync(file).size > budgetBytes) return null;
  return {
    inline_data: {
      mime_type: file.endsWith(".jpg") ? "image/jpeg" : "image/png",
      data: fs.readFileSync(file).toString("base64"),
    },
  };
}

// ---------------------------------------------------------------------------
// rubric mode
// ---------------------------------------------------------------------------
const AXES = [
  ["visual_design", "hierarchy, typography, color, use of space"],
  ["five_second_test", "is it clear who they are and what they do from the hero alone"],
  ["storytelling", "projects framed as problem/outcome vs bare tech lists"],
  ["writing", "typos, clarity, voice"],
  ["memorability", "would you remember this site tomorrow"],
  ["motion", "tasteful / gratuitous / absent — judge from the difference between the two viewport frames"],
];

const axisSchema = {
  type: "OBJECT",
  properties: {
    score: { type: "INTEGER", description: "1 (poor) to 5 (excellent)" },
    note: { type: "STRING", description: "one short sentence of justification" },
  },
  required: ["score", "note"],
};
const rubricSchema = {
  type: "OBJECT",
  properties: {
    is_portfolio: {
      type: "BOOLEAN",
      description:
        "false for parked/hijacked domains, bare starter templates with placeholder content, plain blogs/link hubs with no work shown",
    },
    tier: { type: "STRING", enum: ["S", "A", "B", "C", "D"] },
    ...Object.fromEntries(AXES.map(([k]) => [k, axisSchema])),
  },
  required: ["is_portfolio", "tier", ...AXES.map(([k]) => k)],
};

async function runRubric() {
  try {
    await db.execute("ALTER TABLE portfolios ADD COLUMN ai_rubric TEXT");
  } catch {
    /* column already present */
  }
  const res = await db.execute(
    `SELECT url, name, shot_key FROM portfolios
     WHERE status = 'live' AND shot_key IS NOT NULL
       ${FORCE ? "" : "AND ai_rubric IS NULL"}
     ORDER BY url`
  );
  let queue = res.rows.filter((r) => !ONLY || String(r.url).includes(ONLY));
  queue = queue.slice(0, LIMIT === Infinity ? queue.length : LIMIT);
  console.log(`rubric: judging ${queue.length} site(s) with ${MODEL}`);

  let ok = 0;
  for (const [i, row] of queue.entries()) {
    const url = String(row.url);
    const dir = path.join(ROOT, "captures", String(row.shot_key));
    const parts = [
      {
        text:
          `You are judging a developer's portfolio website: "${row.name}" at ${url}.\n` +
          `Images, in order: (1) the settled desktop viewport, (2) the same viewport 3 seconds later ` +
          `(compare with 1 to judge motion), (3) the full page top to bottom.\n` +
          `Score each axis 1 (poor) to 5 (excellent) with one short justification:\n` +
          AXES.map(([k, d]) => `- ${k}: ${d}`).join("\n") +
          `\nAlso give an overall tier (S = exceptional, rare; A = strong; B = solid; C = weak; D = bad) ` +
          `and whether this is actually a personal portfolio site.`,
      },
      imagePart(path.join(dir, "strip0.png")),
      imagePart(path.join(dir, "strip2.png")),
      imagePart(path.join(dir, "full.jpg")),
    ].filter(Boolean);
    if (parts.length < 2) {
      console.log(`[${i + 1}/${queue.length}] ${url} — skipped (no usable captures)`);
      continue;
    }
    try {
      const rubric = await gemini(parts, rubricSchema);
      rubric.model = MODEL;
      rubric.judged_at = new Date().toISOString();
      await db.execute({
        sql: "UPDATE portfolios SET ai_rubric = ? WHERE url = ?",
        args: [JSON.stringify(rubric), url],
      });
      ok++;
      console.log(
        `[${i + 1}/${queue.length}] ${url} — tier ${rubric.tier}, portfolio=${rubric.is_portfolio}, design=${rubric.visual_design.score}`
      );
    } catch (e) {
      console.log(`[${i + 1}/${queue.length}] ${url} — ERROR ${String(e.message).slice(0, 120)}`);
    }
  }
  console.log(`rubric done: ${ok}/${queue.length} judged, ${calls} API call(s)`);
}

// ---------------------------------------------------------------------------
// pairwise mode
// ---------------------------------------------------------------------------
const pairSchema = {
  type: "OBJECT",
  properties: {
    winner: {
      type: "STRING",
      enum: ["A", "B", "skip"],
      description: "skip only if the shots are unusable or truly indistinguishable",
    },
    reason: { type: "STRING", description: "one short sentence" },
  },
  required: ["winner", "reason"],
};

async function runPairwise() {
  const res = await db.execute(
    `SELECT p.url, p.name, p.shot_key,
            COALESCE(r.elo, ${BASE_ELO}) AS elo, COALESCE(r.votes, 0) AS votes
     FROM portfolios p LEFT JOIN ratings r ON r.url = p.url
     WHERE p.status = 'live' AND p.shot_key IS NOT NULL`
  );
  const pool = res.rows.map((r) => ({
    url: String(r.url),
    name: String(r.name),
    key: String(r.shot_key),
    elo: Number(r.elo),
    votes: Number(r.votes),
  }));
  const voted = await db.execute({
    sql: "SELECT pair_key FROM votes WHERE rater_id = ?",
    args: [RATER_ID],
  });
  const seen = new Set(voted.rows.map((r) => String(r.pair_key)));
  console.log(
    `pairwise: pool ${pool.length} site(s), ${seen.size} pair(s) already voted, casting up to ${VOTES}`
  );

  let cast = 0;
  for (let round = 0; cast < VOTES && round < VOTES * 5; round++) {
    // Uncertainty-prioritized: sample a handful, face off the two least-voted
    // whose ratings are close (same selection spirit as GET /api/rank).
    const sample = [...pool].sort(() => Math.random() - 0.5).slice(0, 12);
    sample.sort((a, b) => a.votes - b.votes || Math.abs(a.elo - b.elo));
    let a = sample[0];
    let b = sample
      .slice(1)
      .find((p) => !seen.has(pairKey(a.url, p.url)));
    if (!b) continue;
    // Randomize A/B presentation so position bias can't favor one slot.
    if (Math.random() < 0.5) [a, b] = [b, a];

    const heroA = imagePart(path.join(ROOT, "captures", a.key, "hero.jpg"));
    const heroB = imagePart(path.join(ROOT, "captures", b.key, "hero.jpg"));
    if (!heroA || !heroB) {
      seen.add(pairKey(a.url, b.url)); // don't re-draw a pair we can't judge
      continue;
    }

    try {
      const verdict = await gemini(
        [
          {
            text:
              `Two developer portfolio heroes. A: "${a.name}". B: "${b.name}".\n` +
              `Which is the better portfolio overall — design, clarity, memorability? ` +
              `Pick a winner; skip only if genuinely unusable or indistinguishable.`,
          },
          { text: "A:" },
          heroA,
          { text: "B:" },
          heroB,
        ],
        pairSchema
      );
      seen.add(pairKey(a.url, b.url));
      if (verdict.winner === "skip") {
        console.log(`  skip: ${a.url} vs ${b.url} — ${verdict.reason}`);
        continue;
      }
      const [win, lose] = verdict.winner === "A" ? [a, b] : [b, a];
      await castVote(win, lose);
      cast++;
      console.log(
        `[${cast}/${VOTES}] ${win.url} beat ${lose.url} — ${verdict.reason}`
      );
    } catch (e) {
      if (/UNIQUE constraint failed/i.test(String(e.message))) {
        seen.add(pairKey(a.url, b.url));
        continue;
      }
      console.log(`  ERROR ${a.url} vs ${b.url}: ${String(e.message).slice(0, 120)}`);
    }
  }
  console.log(`pairwise done: ${cast} vote(s) cast, ${calls} API call(s)`);
}

// Mirrors POST /api/rank: insert + ELO upsert in one write transaction, with
// the UNIQUE(rater_id, pair_key) index as the dup backstop. AI votes move
// official ELO — that is the whole point of the bootstrap (GRADING §7).
async function castVote(win, lose) {
  const tx = await db.transaction("write");
  try {
    const rres = await tx.execute({
      sql: "SELECT url, elo, votes FROM ratings WHERE url IN (?, ?)",
      args: [win.url, lose.url],
    });
    const map = new Map(
      rres.rows.map((r) => [String(r.url), { elo: Number(r.elo), votes: Number(r.votes) }])
    );
    const w = map.get(win.url) ?? { elo: BASE_ELO, votes: 0 };
    const l = map.get(lose.url) ?? { elo: BASE_ELO, votes: 0 };
    const updated = eloUpdate(w.elo, l.elo);
    await tx.execute({
      sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id) VALUES (?, ?, ?, 'ai', ?)",
      args: [win.url, lose.url, pairKey(win.url, lose.url), RATER_ID],
    });
    const upsert = `INSERT INTO ratings (url, elo, votes, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(url) DO UPDATE SET
        elo = excluded.elo, votes = excluded.votes, updated_at = excluded.updated_at`;
    await tx.execute({ sql: upsert, args: [win.url, updated.winner, w.votes + 1] });
    await tx.execute({ sql: upsert, args: [lose.url, updated.loser, l.votes + 1] });
    await tx.commit();
    // keep in-memory pool fresh so later pair picks use updated numbers
    win.elo = updated.winner;
    win.votes = w.votes + 1;
    lose.elo = updated.loser;
    lose.votes = l.votes + 1;
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------------------
if (MODE === "rubric") await runRubric();
else if (MODE === "pairwise") await runPairwise();
else {
  console.error("usage: node pipeline/judge.mjs rubric|pairwise [flags]");
  process.exit(1);
}
