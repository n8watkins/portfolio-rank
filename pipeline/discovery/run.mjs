// The discovery pipeline's run (docs/DISCOVERY.md; .github/workflows/discover.yml).
//
//   node pipeline/discovery/run.mjs [--sources all|none|<key>,<key>] [--caps '<json>'] [--summary <file.json>]
//
// Stages, each reading only its own queue in discovery_sites, so a run can
// stop anywhere and the next one carries on:
//   1. sources   each source that is due reads from its watermark; every
//                address is normalized, checked against the list
//                (feed.json, additions.json, excluded.json) and the seen-set
//                (one primary-key read each), and new ones are written as
//                `found`; then, last, the watermark moves
//   2. recheck   dropped rows whose recheck date has come go back to `found`
//   3. check     up to caps.found `found` rows: one fetch each, the code
//                checks and the language and topic filter; each becomes
//                `dropped` (with a reason) or `screen` (with its evidence)
//   4. screen    the AI screen on Gemini 3.1 Flash-Lite, 20 sites a
//                request, within caps.screenRequests a quota day; only with
//                DISCOVERY_SCREEN=on and a GEMINI_API_KEY
//   5. hand-off  `pending` rows to the grader's queue at caps.handoffPerDay;
//                only with DISCOVERY_HANDOFF=on
//
// Environment: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (or LOCAL_DB_FILE),
// GITHUB_TOKEN (GitHub search and profiles), GEMINI_API_KEY,
// DISCOVERY_SCREEN, DISCOVERY_HANDOFF, DISCOVERY_CAPS (JSON, over the
// defaults below), GRADER_CAPS, GITHUB_STEP_SUMMARY.
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { DISCOVERY_TABLES, addFound, queue, reopenDue, seenKey, seenMany, settle } from "../../lib/discovery/sites.mjs";
import { siteKeyOf } from "../../lib/grader/url.mjs";
import { guardedFetch } from "../net-guard-node.mjs";
import { createGemini } from "../gemini.mjs";
import { createRequestLog, ensureGeminiLog } from "../gemini-log.mjs";
import { checkPage } from "./check.mjs";
import { filterPage } from "./filter.mjs";
import { createHttp, mapLimit } from "./http.mjs";
import { handoff } from "./handoff.mjs";
import { normalizeCandidate } from "./normalize.mjs";
import { SCREEN_JOB, SCREEN_MODEL, BATCH, screenRows, screenedToday } from "./screen.mjs";
import { TOPICS, readTopic } from "./sources/github.mjs";
import { readComments, readHired, readShare } from "./sources/hn.mjs";
import { readPersonalSites, readUses } from "./sources/lists.mjs";
import { isDue, moveWatermark, readWatermark } from "./watermark.mjs";

export const DEFAULT_CAPS = {
  // A GitHub topic opens no more search windows once it has this many repos in a run (the rest waits behind its watermark).
  perSource: 3000,
  // Older months of each GitHub topic read per run (the back catalog).
  backMonths: 2,
  // Older "Who wants to be hired?" threads, and "Share your personal site" threads, read per run.
  hnBackThreads: 1,
  hnShareThreads: 1,
  // `found` rows fetched and checked per run, and rechecks reopened per run.
  found: 600,
  recheck: 200,
  // AI screen requests per quota day (20 sites each) of Gemini 3.1 Flash-Lite's 500.
  screenRequests: 25,
  // Hand-offs to the grader: per quota day, discovery jobs waiting at once,
  // and places in today's grading share always left for people.
  handoffPerDay: 10,
  handoffWaiting: 10,
  handoffReserve: 40,
};

/** DEFAULT_CAPS with a DISCOVERY_CAPS JSON override; junk is ignored, negatives become 0. */
export function discoveryCaps(raw) {
  let over = {};
  try {
    over = raw ? JSON.parse(raw) : {};
  } catch {
    over = {};
  }
  const out = { ...DEFAULT_CAPS };
  for (const k of Object.keys(DEFAULT_CAPS)) if (over[k] !== null && over[k] !== "" && Number.isFinite(Number(over[k]))) out[k] = Math.max(0, Math.floor(Number(over[k])));
  return out;
}

/** Every source: its key, how often it is read (days) and its reader. */
export const SOURCES = [
  ...TOPICS.map((t) => ({ key: `github:${t}`, every: 7, read: (ctx, c) => readTopic(ctx, t, c) })),
  { key: "hn:comments", every: 7, read: readComments },
  { key: "hn:hired", every: 7, read: readHired },
  { key: "hn:share", every: 30, read: readShare },
  { key: "personalsites", every: 7, read: readPersonalSites },
  { key: "uses", every: 7, read: readUses },
];

/** The site keys already on the list (feed.json, additions.json) or taken off it (excluded.json). */
export function listedKeys(dataDir) {
  const keys = new Set();
  for (const f of ["feed.json", "additions.json", "excluded.json"]) {
    let rows = [];
    try {
      rows = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));
    } catch {
      continue;
    }
    for (const e of rows) {
      const n = normalizeCandidate(typeof e === "string" ? e : e?.url);
      if (n.ok) keys.add(n.key);
    }
  }
  return keys;
}

/**
 * The new addresses of one source's items: deduped within the run, minus
 * the list and the seen-set. Hacker News hosts that three or more people
 * posted are a library or a product, not someone's own site (the pilot's
 * rule), and are marked so the check drops them without a fetch.
 */
export async function newItems(db, items, { listed, taken = new Set() }) {
  const authors = new Map();
  for (const it of items) {
    if (it.source !== "hn" || !it.author) continue;
    const host = new URL(it.url).hostname;
    if (!authors.has(host)) authors.set(host, new Set());
    authors.get(host).add(it.author);
  }
  const fresh = [];
  for (const it of items) {
    const key = siteKeyOf(it.url);
    if (listed.has(key) || taken.has(key)) continue;
    taken.add(key);
    const shared = it.source === "hn" && (authors.get(new URL(it.url).hostname)?.size ?? 0) >= 3;
    fresh.push(shared ? { ...it, context: { ...it.context, sharedLink: true } } : it);
  }
  const seen = await seenMany(db, fresh.map((i) => i.url));
  return fresh.filter((i) => !seen.has(seenKey(i.url)));
}

/** Stage 3 for one row: the outcome to settle (pure apart from the fetch). */
export async function judgeRow(row, io) {
  if (!row.url) return { key: row.key, status: "dropped", reason: "dead", detail: "no_address" };
  if (row.work?.sharedLink) return { key: row.key, status: "dropped", reason: "not_portfolio", detail: "shared_link_many_authors" };
  const c = await checkPage({ url: row.url, context: row.work }, io);
  if (c.status === "dropped") return { key: row.key, status: "dropped", reason: c.reason, detail: c.detail };
  const f = filterPage(c.evidence);
  if (!f.keep) return { key: row.key, status: "dropped", reason: f.reason, detail: f.detail };
  return { key: row.key, status: "screen", finalKey: c.finalKey, siteKey: siteKeyOf(row.url), work: { evidence: c.evidence, priority: f.priority } };
}

const bump = (o, k, n = 1) => (o[k] = (o[k] ?? 0) + n);

/**
 * One run. Everything outside the database comes in through `io`, so the
 * tests run it end to end with stand-ins.
 */
export async function runDiscovery({ db, io, caps, sources = SOURCES, now = new Date(), screen = null, handoffOn = false, listed = new Set(), log = console.log }) {
  await db.batch(DISCOVERY_TABLES, "write");
  const summary = { at: now.toISOString(), caps, sources: {}, recheck: 0, check: { rows: 0, outcomes: {}, details: {} }, screen: { ran: false }, handoff: { ran: false } };

  // 1. Sources: rows first, then the watermark.
  const taken = new Set();
  for (const s of sources) {
    const { cursor, readAt } = await readWatermark(db, s.key);
    if (!isDue(readAt, s.every, now)) {
      summary.sources[s.key] = { skipped: `read ${readAt}` };
      continue;
    }
    try {
      const res = await s.read({ ...io, now, caps: { ...caps, maxItems: caps.perSource }, log }, cursor);
      // Every new address is written (a cheap `found` row) before the watermark moves, so none is lost;
      // caps.found paces the fetches, and perSource only stops a source from opening more windows.
      const fresh = await newItems(db, res.items, { listed, taken });
      const added = await addFound(db, fresh, { now });
      await moveWatermark(db, s.key, res.cursor, { now });
      summary.sources[s.key] = { read: res.items.length, new: fresh.length, added, cursor: res.cursor };
      log(`${s.key}: ${res.items.length} read, ${added} new`);
    } catch (e) {
      summary.sources[s.key] = { error: String(e?.message ?? e).slice(0, 200) };
      log(`${s.key}: failed, watermark kept: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }

  // 2. Rechecks that are due.
  summary.recheck = await reopenDue(db, { now, limit: caps.recheck });

  // 3. Fetch once, code checks, language and topic filter.
  const rows = await queue(db, "found", caps.found);
  const results = await mapLimit(rows, 8, (row) =>
    judgeRow(row, io).catch((e) => ({ key: row.key, status: "dropped", reason: "dead", detail: `check_crash:${String(e?.message ?? e).slice(0, 40)}` }))
  );
  // A page that redirects to a site already listed, seen, or kept earlier in this run is a duplicate.
  const finals = results.filter((r) => r.status === "screen" && r.finalKey !== r.siteKey);
  const finalSeen = await seenMany(db, finals.map((r) => `https://${r.finalKey}`));
  const keptFinal = new Set();
  for (const r of results) {
    if (r.status !== "screen") continue;
    const dup = keptFinal.has(r.finalKey) || (r.finalKey !== r.siteKey && (listed.has(r.finalKey) || finalSeen.has(seenKey(`https://${r.finalKey}`))));
    keptFinal.add(r.finalKey);
    if (dup) Object.assign(r, { status: "dropped", reason: "duplicate", detail: "duplicate_final_url", work: null });
  }
  await settle(db, results, { now });
  summary.check.rows = rows.length;
  for (const r of results) {
    bump(summary.check.outcomes, r.status === "dropped" ? r.reason : r.status);
    if (r.detail) bump(summary.check.details, r.detail);
  }
  log(`check: ${rows.length} rows, ${JSON.stringify(summary.check.outcomes)}`);

  // 4. The AI screen.
  if (screen) {
    const used = await screenedToday(db, now);
    const requests = Math.max(0, caps.screenRequests - used);
    const todo = requests ? await queue(db, "screen", requests * BATCH) : [];
    const res = await screenRows(todo, { generate: screen.generate, requests, log });
    await settle(db, res.outcomes, { now });
    summary.screen = { ran: true, usedBefore: used, requests: res.requests, stopped: res.stopped, outcomes: {} };
    for (const o of res.outcomes) bump(summary.screen.outcomes, o.status === "dropped" ? o.reason : o.status);
  }

  // 5. Hand-off to the grader.
  if (handoffOn) {
    summary.handoff = { ran: true, ...(await handoff(db, { perDay: caps.handoffPerDay, waiting: caps.handoffWaiting, reserve: caps.handoffReserve, now, graderCapsRaw: io.graderCaps, log })) };
  }

  // Queue sizes after the run: each count reads only its status's partial index.
  summary.queues = {};
  for (const q of ["found", "screen", "pending", "queued"]) {
    const r = await db.execute({ sql: "SELECT COUNT(*) AS n FROM discovery_sites WHERE status = ?", args: [q] });
    summary.queues[q] = Number(r.rows[0]?.n ?? 0);
  }
  return summary;
}

/** The run's Markdown summary for the Actions job page. */
export function markdownSummary(s) {
  const lines = [`## Discovery run ${s.at}`, "", "| Source | Read | New | Note |", "|---|---:|---:|---|"];
  for (const [k, v] of Object.entries(s.sources)) lines.push(`| ${k} | ${v.read ?? ""} | ${v.added ?? ""} | ${v.error ? `failed: ${v.error}` : v.skipped ? `not due (${v.skipped})` : ""} |`);
  lines.push("", `Rechecks reopened: ${s.recheck}. Checked: ${s.check.rows}.`, "", "| Outcome | Sites |", "|---|---:|");
  for (const [k, n] of Object.entries(s.check.outcomes)) lines.push(`| ${k} | ${n} |`);
  lines.push("", "| Check detail | Sites |", "|---|---:|");
  for (const [k, n] of Object.entries(s.check.details).sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${n} |`);
  lines.push("", s.screen.ran ? `AI screen: ${s.screen.requests} request(s), ${JSON.stringify(s.screen.outcomes)}${s.screen.stopped ? `, stopped: ${s.screen.stopped}` : ""}.` : "AI screen: off.");
  lines.push(s.handoff.ran ? `Hand-off: ${s.handoff.handed} handed to the grader; ${s.handoff.graded} graded, ${s.handoff.notPortfolio} not a portfolio, ${s.handoff.failed} failed.` : "Hand-off: off.");
  lines.push("", `Queues after the run: ${Object.entries(s.queues).map(([k, n]) => `${k} ${n}`).join(", ")}.`);
  return lines.join("\n");
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const env = process.env;
  const db = env.TURSO_DATABASE_URL
    ? createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN })
    : createClient({ url: `file:${env.LOCAL_DB_FILE ?? path.join(process.cwd(), "data", "portfoliorank.db")}` });
  const caps = discoveryCaps(arg("caps") ?? env.DISCOVERY_CAPS);
  const which = arg("sources") ?? "all";
  const sources = which === "all" ? SOURCES : which === "none" ? [] : SOURCES.filter((s) => which.split(",").includes(s.key));
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || "";
  const http = createHttp({
    // GitHub search allows 30 a minute with a token and 10 without.
    gaps: { "api.github.com": token ? 2200 : 6500, "hn.algolia.com": 400, "raw.githubusercontent.com": 50 },
    headers: (u) => (u.host === "api.github.com" && token ? { authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" } : {}),
  });
  const graphql = token
    ? async (query) => {
        const res = await fetch("https://api.github.com/graphql", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(30000) });
        const body = await res.json();
        return body.data;
      }
    : null;
  const pageFetch = guardedFetch();
  const io = {
    http,
    graphql,
    fetchPage: pageFetch,
    fetchText: async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      return res.ok ? (await res.text()).slice(0, 300_000) : null;
    },
    graderCaps: env.GRADER_CAPS,
  };
  let screen = null;
  if (/^on$/i.test(env.DISCOVERY_SCREEN ?? "") && env.GEMINI_API_KEY) {
    await ensureGeminiLog(db);
    const reqLog = createRequestLog({ db, job: SCREEN_JOB });
    const gemini = createGemini({ apiKey: env.GEMINI_API_KEY, models: [SCREEN_MODEL], rpm: 10, retryBudget: 6, onRequest: (r) => reqLog.record(r) });
    screen = { generate: gemini.generate };
  }
  const summary = await runDiscovery({
    db,
    io,
    caps,
    sources,
    screen,
    handoffOn: /^on$/i.test(env.DISCOVERY_HANDOFF ?? ""),
    listed: listedKeys(path.join(process.cwd(), "data")),
  });
  summary.requests = http.counts;
  const md = markdownSummary(summary);
  console.log(md);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${md}\n`);
  const out = arg("summary");
  if (out) fs.writeFileSync(out, JSON.stringify(summary, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
