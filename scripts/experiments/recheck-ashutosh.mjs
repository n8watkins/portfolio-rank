#!/usr/bin/env node
// Owner request, 2026-11-13, separate from the locked two-sets experiment:
// https://about.ashutoshcodes.in/ opens on a "Choose a Theme" modal (9
// themes, a "Continue with ChatGPT" button). Two bundles with the two-sets
// capture code: (a) the default visitor view after the primary "Continue..."
// button; (b) the "Model Card Resume" theme (its card, then Continue). Each
// is graded once with the locked solo prompt on gemini-3.1-flash-lite
// (temperature 0.2, thinking "low"), logged as job "exp-recheck". Hard stop
// at 4 HTTP requests; refuses to start when the model's requests today plus 2
// would pass 495.
//
//   node scripts/experiments/recheck-ashutosh.mjs capture
//   pass-env run -e GEMINI_API_KEY=portfolio-rank/GEMINI_API_KEY \
//     -e TURSO_DATABASE_URL=portfolio-rank/TURSO_DATABASE_URL \
//     -e TURSO_AUTH_TOKEN=portfolio-rank/TURSO_AUTH_TOKEN \
//     -- node scripts/experiments/recheck-ashutosh.mjs grade
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
const MODEL = "gemini-3.1-flash-lite";

const clickContinue = async (page, timeout = 10000) => {
  const b = page.locator("button").filter({ hasText: /^\s*continue/i }).filter({ visible: true }).first();
  await b.waitFor({ state: "visible", timeout });
  const label = (await b.innerText()).trim();
  await b.click({ timeout: 5000 });
  return label;
};
const settle = async (page) => {
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2500);
};

// The listed name is "Ashutosh Pandey" (read-only lookup); the page shows it too.
export const VIEWS = [
  {
    id: "S1",
    dir: "ashutoshcodes/continue",
    prepare: async (page) => {
      const label = await clickContinue(page);
      await settle(page);
      return `clicked "${label}"`;
    },
  },
  {
    id: "S2",
    dir: "ashutoshcodes/model-card",
    prepare: async (page) => {
      const card = page.getByText(/model card resume/i).filter({ visible: true }).first();
      await card.waitFor({ state: "visible", timeout: 10000 });
      await card.click({ timeout: 5000 });
      await page.waitForTimeout(800);
      // Picking a card may apply the theme and close the dialog at once.
      const label = await clickContinue(page, 3000).catch(() => null);
      await settle(page);
      const open = await page.evaluate(() => [...document.querySelectorAll("dialog")].some((d) => d.open));
      return `picked "Model Card Resume", then ${label ? `clicked "${label}"` : "no Continue button was left"}; dialog ${open ? "still open" : "closed"}`;
    },
  },
];
const SITE = { url: "https://about.ashutoshcodes.in/", name: "Ashutosh Pandey" };

async function capture() {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    for (const v of VIEWS) {
      const dir = path.join(ROOT, v.dir);
      const t0 = Date.now();
      const measured = await captureOne(browser, SITE, dir, { shots: true, prepare: v.prepare });
      const seconds = (Date.now() - t0) / 1000;
      const outline = readJson(path.join(dir, "outline.json"));
      const ex = buildExcerpt(outline);
      fs.writeFileSync(path.join(dir, "text.txt"), `${redactContacts(clean(ex.text, 6000)).trim()}\n`);
      writeJson(path.join(dir, "facts.json"), factsFor(SITE, measured, ex));
      writeJson(path.join(dir, "capture-time.json"), { seconds, desktop: measured.prepared_desktop, phone: measured.prepared_phone });
      const link = path.join(ROOT, "bundles", "S", v.id);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      if (!fs.existsSync(link)) fs.symlinkSync(dir, link);
      console.log(`${v.id} ${v.dir}: ${seconds.toFixed(1)} s; desktop ${measured.prepared_desktop}; phone ${measured.prepared_phone}; ${outline.text.length} chars`);
    }
  } finally {
    await browser.close();
  }
}

async function grade() {
  if (!process.env.TURSO_DATABASE_URL) throw new Error("grade logs to gemini_requests: needs TURSO_DATABASE_URL through pass-env");
  const { pipelineDb } = await import("../../pipeline/roster.mjs");
  const db = pipelineDb(path.join(import.meta.dirname, "..", ".."));
  const used = (await dailyTotals(db)).used.get(MODEL)?.n ?? 0;
  console.log(`${MODEL}: ${used} requests this Pacific quota day`);
  if (used + VIEWS.length > 495) throw new Error(`refusing: ${used} + ${VIEWS.length} would pass 495`);
  const plan = { requests: VIEWS.map((v) => ({ key: `recheck-ashutosh/${v.id}`, step: "recheck-ashutosh", set: "S", kind: "solo", ids: [v.id] })) };
  const settings = { ...SETTINGS, model: MODEL, job: "exp-recheck", hard_stop: 4, day_cap: 495 };
  const { exit } = await run({ db, plan, settings, out: path.join(ROOT, "gemini-3.1"), rawDir: path.join(ROOT, "raw-3.1"), bundleRoot: path.join(ROOT, "bundles"), timelinePath: path.join(ROOT, "timeline.json") });
  process.exit(exit === "done" ? 0 : 3);
}

const step = process.argv[2];
if (step === "capture") await capture();
else if (step === "grade") await grade();
else {
  console.error("usage: recheck-ashutosh.mjs <capture|grade>");
  process.exit(1);
}
