#!/usr/bin/env node
// Owner request, 2026-11-13, separate from the locked two-sets experiment:
// re-check three sites production graded "not a portfolio". Each is captured
// fresh with the two-sets capture code (desktop and phone tops, page text,
// first-screen facts); abbasraza.dev twice, as-is and after clicking its
// "CLICK TO CONTINUE" splash. Each bundle is graded once with the locked solo
// prompt on gemini-3.5-flash-lite (same settings and retry policy), logged as
// job "exp-recheck". Hard stop at 8 HTTP requests; the run refuses to start
// when today's requests plus 4 would pass 495, and the day cap stops it at 495.
//
//   node scripts/experiments/recheck-not-portfolio.mjs capture
//   pass-env run -e GEMINI_API_KEY=portfolio-rank/GEMINI_API_KEY \
//     -e TURSO_DATABASE_URL=portfolio-rank/TURSO_DATABASE_URL \
//     -e TURSO_AUTH_TOKEN=portfolio-rank/TURSO_AUTH_TOKEN \
//     -- node scripts/experiments/recheck-not-portfolio.mjs grade
import fs from "fs";
import os from "os";
import path from "path";
import { buildExcerpt } from "../../pipeline/excerpt.mjs";
import { dailyTotals } from "../../pipeline/gemini-log.mjs";
import { redactContacts } from "../../pipeline/redact.mjs";
import { captureOne, clean, factsFor } from "./grading-two-sets.mjs";
import { readJson, writeJson } from "./grading-two-sets-lib.mjs";
import { SETTINGS, run } from "./grading-two-sets-run.mjs";

const ROOT = path.join(os.homedir(), "research", "portfoliorank-experiments", "recheck");
// The names are the ones stored in portfolios.name (read-only lookup, 2026-11-13).
export const SITES = [
  { id: "R1", url: "https://abbasraza.dev", name: "Abbas Raza", dir: "abbasraza.dev/as-is", click: false },
  { id: "R2", url: "https://abbasraza.dev", name: "Abbas Raza", dir: "abbasraza.dev/clicked", click: true },
  { id: "R3", url: "https://cade.codes", name: "Cade Kynaston", dir: "cade.codes", click: false },
  { id: "R4", url: "https://davidesantangelo.com", name: "Davide Santangelo", dir: "davidesantangelo.com", click: false },
];

async function capture() {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    for (const s of SITES) {
      const dir = path.join(ROOT, s.dir);
      const measured = await captureOne(browser, s, dir, { shots: true, click: s.click });
      const outline = readJson(path.join(dir, "outline.json"));
      const ex = buildExcerpt(outline);
      fs.writeFileSync(path.join(dir, "text.txt"), `${redactContacts(clean(ex.text, 6000)).trim()}\n`);
      writeJson(path.join(dir, "facts.json"), factsFor(s, measured, ex));
      // The harness reads bundles at <root>/<set>/<id>: link each id to its folder.
      const link = path.join(ROOT, "bundles", "R", s.id);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      if (!fs.existsSync(link)) fs.symlinkSync(dir, link);
      console.log(`${s.id} ${s.url}${s.click ? ` (clicked ${measured.clicked_desktop} / ${measured.clicked_phone})` : ""}: ${outline.text.length} chars`);
    }
  } finally {
    await browser.close();
  }
}

async function grade() {
  if (!process.env.TURSO_DATABASE_URL) throw new Error("grade logs to gemini_requests: needs TURSO_DATABASE_URL through pass-env");
  const { pipelineDb } = await import("../../pipeline/roster.mjs");
  const db = pipelineDb(path.join(import.meta.dirname, "..", ".."));
  const used = (await dailyTotals(db)).used.get(SETTINGS.model)?.n ?? 0;
  console.log(`${SETTINGS.model}: ${used} requests this Pacific quota day`);
  if (used + SITES.length > 495) throw new Error(`refusing: ${used} + ${SITES.length} would pass 495`);
  const plan = { requests: SITES.map((s) => ({ key: `recheck/${s.id}`, step: "recheck", set: "R", kind: "solo", ids: [s.id] })) };
  const settings = { ...SETTINGS, job: "exp-recheck", hard_stop: 8, day_cap: 495 };
  const { exit } = await run({ db, plan, settings, out: path.join(ROOT, "gemini"), rawDir: path.join(ROOT, "raw"), bundleRoot: path.join(ROOT, "bundles"), timelinePath: path.join(ROOT, "timeline.json") });
  process.exit(exit === "done" ? 0 : 3);
}

const step = process.argv[2];
if (step === "capture") await capture();
else if (step === "grade") await grade();
else {
  console.error("usage: recheck-not-portfolio.mjs <capture|grade>");
  process.exit(1);
}
