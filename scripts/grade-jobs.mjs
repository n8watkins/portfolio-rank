#!/usr/bin/env node
// "Grade my portfolio" on GitHub Actions (.github/workflows/grade.yml,
// started by the Worker with a workflow_dispatch; AUTOMATION.md "Grade my
// portfolio"). Until no job is left or the time is up, it:
//
//   1. claims up to 3 jobs waiting for a capture (lib/grader/jobs.mjs
//      claimCaptures; two runs never take the same job)
//   2. captures each in Chromium behind the filtering proxy, so neither the
//      page nor our link checks can reach a private address
//      (pipeline/grade-capture.mjs, pipeline/net-guard-node.mjs)
//   3. uploads hero.jpg and mobile.jpg to the SHOTS bucket under the
//      private prefix private/grades/<id>/, which the site's public /shots
//      route never serves
//   4. records the capture; a free-tier job is then graded through the
//      people queue (lib/grader/queue.mjs: 3.5 Flash-Lite only, the budget
//      accountant's people allowance, waiting for 3.5 rather than falling
//      back); an own-key job waits for the visitor's browser
//
// The repository is public, so this job's log is public: it prints counts
// and outcomes only, never an address, a job id (a report's only key), page
// text or an error that could echo them.
//
//   node scripts/grade-jobs.mjs [--minutes 12] [--max 15]
// Needs TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (else the local database),
// R2_* (else screenshots stay local and grades read them from disk) and
// GEMINI_API_KEY (else free-tier grades wait in the people queue for the
// Worker's hourly drain).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { pipelineDb } from "../pipeline/roster.mjs";
import { createFilteringProxy, guardedFetch } from "../pipeline/net-guard-node.mjs";
import { capturePage } from "../pipeline/grade-capture.mjs";
import { ensureGraderSchema } from "../lib/grader/schema.mjs";
import { claimCaptures, readJob, shotKeyOf } from "../lib/grader/jobs.mjs";
import { failCapture, recordCapture } from "../lib/grader/finish.mjs";
import { peopleContext, queueFreeGrade } from "../lib/grader/queue.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const MINUTES = Number(flag("minutes", "12"));
const MAX = Number(flag("max", "15"));
const RUN_ID = process.env.GITHUB_RUN_ID ? `gh-${process.env.GITHUB_RUN_ID}` : `local-${process.pid}`;

const db = pipelineDb(ROOT);
await ensureGraderSchema(db);

let s3 = null;
if (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID) {
  const { S3Client } = await import("@aws-sdk/client-s3");
  s3 = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
}
async function upload(key, file) {
  if (!s3) return;
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET ?? "portfolio-rank", Key: key, Body: fs.readFileSync(file), ContentType: "image/jpeg" }));
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "grade-"));
const proxy = await createFilteringProxy();
// Chromium gets no secrets: a minimal environment, every request through the proxy.
const browser = await chromium.launch({
  proxy: { server: proxy.url },
  args: ["--proxy-bypass-list=<-loopback>", "--disable-features=WebRtcHideLocalIpsWithMdns", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
  env: { PATH: process.env.PATH ?? "", HOME: work },
});
const linkFetch = guardedFetch();
const counts = { claimed: 0, captured: 0, failed: 0, graded: 0, queued: 0, gradeFailed: 0, awaitingKey: 0 };
const deadline = Date.now() + MINUTES * 60000;
const local = new Map(); // shot key -> local hero file, for grading without R2

const ctx = peopleContext({
  db,
  env: process.env,
  runId: RUN_ID,
  image: async (shotKey) => {
    const file = local.get(String(shotKey).replace(/\/hero\.jpg$/, ""));
    if (!file || !fs.existsSync(file)) return "missing";
    return { inline_data: { mime_type: "image/jpeg", data: fs.readFileSync(file).toString("base64") } };
  },
  // Never the line itself: it can carry Gemini's error text.
  log: () => {},
});

try {
  while (Date.now() < deadline && counts.claimed < MAX) {
    const jobs = await claimCaptures(db, { runId: RUN_ID, limit: Math.min(3, MAX - counts.claimed) });
    if (!jobs.length) break;
    counts.claimed += jobs.length;
    for (const { id, url } of jobs) {
      const dir = path.join(work, id);
      let shot;
      try {
        // A page that hangs a script or a load forever loses its turn after 3 minutes.
        let timer;
        const limit = new Promise((resolve) => (timer = setTimeout(() => resolve({ ok: false, reason: "The page took too long to capture." }), 180000)));
        shot = await Promise.race([capturePage(browser, url, { dir, linkFetch }), limit]);
        clearTimeout(timer);
      } catch {
        shot = { ok: false, reason: "The page couldn't be captured." };
      }
      if (!shot.ok) {
        await failCapture(db, id, shot.reason);
        counts.failed++;
        continue;
      }
      const shotKey = shotKeyOf(id);
      try {
        await upload(`${shotKey}/hero.jpg`, shot.files.hero);
        if (shot.files.mobile) await upload(`${shotKey}/mobile.jpg`, shot.files.mobile);
      } catch {
        await failCapture(db, id, "The screenshot couldn't be stored. Please try again.");
        counts.failed++;
        continue;
      }
      local.set(shotKey, shot.files.hero);
      const status = await recordCapture(db, id, { finalUrl: shot.finalUrl, shotKey, pageText: shot.pageText, facts: shot.facts, meta: shot.meta });
      counts.captured++;
      if (status === "awaiting_key") {
        counts.awaitingKey++;
        continue;
      }
      if (status !== "grading") continue;
      const job = await readJob(db, id);
      const out = await queueFreeGrade(ctx, job);
      if (out === "done") counts.graded++;
      else if (out === "failed") counts.gradeFailed++;
      else counts.queued++;
    }
  }
} finally {
  await browser.close().catch(() => {});
  await proxy.close();
  fs.rmSync(work, { recursive: true, force: true });
}

const line = `grade jobs: ${counts.claimed} claimed, ${counts.captured} captured, ${counts.failed} failed to capture; ${counts.graded} graded, ${counts.queued} waiting for Gemini 3.5, ${counts.gradeFailed} grade failures, ${counts.awaitingKey} waiting for the visitor's own key; ${proxy.stats.blocked} request(s) to private or non-web addresses refused`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
