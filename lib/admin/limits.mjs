// Every free allowance PortfolioRank depends on, in one list, against what is
// used today (the /admin/limits page, GET /api/admin/quota as `limits`).
// Owner rule: never pay, and grow to 50,000 portfolios inside the free
// tiers (docs/audits/free-tier-limits.md has the measurements and the plan).
//
// Two kinds of numbers:
// - live: what the app counts itself (Gemini requests, PageSpeed results
//   stored, emails, Workers AI images and neurons, Tavily credits, Pexels
//   searches), read here on each view with indexed reads;
// - snapshot: account-wide usage only the providers know (Turso rows read and
//   written and storage, R2 storage and operations, Workers requests and CPU
//   time), written into limit_snapshots by scripts/limits-snapshot.mjs (the
//   daily limits.yml workflow, or by hand), with the time it was measured.
//
// Each row has a warning share (WARN, 50% by default: docs/COSTS.md section
// C, fix 10, "act at 50% of any limit") and a danger share (DANGER, 80%),
// and the projected use at 5,000, 20,000 and 50,000 portfolios from the
// audit's per-site rates (PROJECTIONS), so the page answers both "are we
// fine today" and "what breaks first as the library grows".
import { quotaDay } from "../../pipeline/quota-day.mjs";

export const WARN = 0.5;
export const DANGER = 0.8;
/** A snapshot older than this is shown as stale. */
export const STALE_MS = 36 * 60 * 60 * 1000;
/** The library sizes the projections are for. */
export const SIZES = [5000, 20000, 50000];

const GB = 1e9;

/**
 * The free limits. `scope` says who shares it: "account" (every app on the
 * Cloudflare or Turso account) or "app" (PortfolioRank alone). `period` is
 * how the provider counts: "month", "day" or "total" (storage). `warn`
 * overrides WARN where a limit is meant to fill (Gemini's daily allowance
 * is spent by the background on purpose; people keep a reserve).
 */
export const LIMITS = [
  { key: "turso.read", group: "Turso (database)", label: "Rows read", unit: "rows", cap: 500e6, period: "month", scope: "account", source: "snapshot", over: "every query is blocked until the month resets" },
  { key: "turso.write", group: "Turso (database)", label: "Rows written", unit: "rows", cap: 10e6, period: "month", scope: "account", source: "snapshot", over: "every query is blocked until the month resets" },
  { key: "turso.storage", group: "Turso (database)", label: "Storage", unit: "bytes", cap: 5 * GB, period: "total", scope: "account", source: "snapshot", over: "writes are blocked" },
  { key: "r2.storage", group: "R2 (screenshots and page cache)", label: "Storage", unit: "bytes", cap: 10 * GB, period: "total", scope: "account", source: "snapshot", over: "billed at $0.015 per GB-month" },
  { key: "r2.classA", group: "R2 (screenshots and page cache)", label: "Class A operations (writes, lists)", unit: "ops", cap: 1e6, period: "month", scope: "account", source: "snapshot", over: "billed at $4.50 per million" },
  { key: "r2.classB", group: "R2 (screenshots and page cache)", label: "Class B operations (reads)", unit: "ops", cap: 10e6, period: "month", scope: "account", source: "snapshot", over: "billed at $0.36 per million" },
  { key: "workers.requests", group: "Workers", label: "Requests", unit: "requests", cap: 10e6, period: "month", scope: "account", source: "snapshot", over: "billed at $0.30 per million" },
  { key: "workers.cpu", group: "Workers", label: "CPU time", unit: "ms", cap: 30e6, period: "month", scope: "account", source: "snapshot", over: "billed at $0.02 per million ms" },
  { key: "gemini", group: "Google", label: "Gemini requests", unit: "requests", cap: 500, period: "day", scope: "app", source: "live", warn: 1, over: "refused until midnight Pacific; the background fills it on purpose and keeps a reserve for people" },
  { key: "psi", group: "Google", label: "PageSpeed runs (results stored)", unit: "runs", cap: 25000, period: "day", scope: "app", source: "live", over: "refused until midnight Pacific (no billing account)" },
  { key: "email.day", group: "Email", label: "Emails today (the gate's cap)", unit: "emails", cap: 100, period: "day", scope: "app", source: "live", over: "the gate refuses more until midnight Pacific" },
  { key: "email.month", group: "Email", label: "Emails this month (PortfolioRank's share)", unit: "emails", cap: 150, period: "month", scope: "app", source: "live", over: "the mailroom refuses; the account's 3,000 a month are shared by every app" },
  { key: "ai.neurons", group: "Workers AI", label: "Neurons today (PortfolioRank's slice)", unit: "neurons", cap: 2500, period: "day", scope: "app", source: "live", over: "refused by the neuron guard; the account's free 10,000 a day are shared" },
  { key: "tavily", group: "Search", label: "Tavily credits (PortfolioRank's share)", unit: "credits", cap: 200, period: "month", scope: "app", source: "live", over: "outside claims are cut from drafts" },
  { key: "pexels", group: "Search", label: "Pexels searches", unit: "searches", cap: 500, period: "month", scope: "app", source: "live", over: "stopped by the runaway cap (Pexels allows 20,000)" },
];

/**
 * Projected use at each library size, from the audit's measurements
 * (docs/audits/free-tier-limits.md, "Projections"), with this repository's
 * fixes in place. `per` is how it is counted. Rows not listed don't grow
 * with the library (they follow visitors or the fixed daily budgets).
 */
export const PROJECTIONS = {
  "turso.read": { 5000: 30e6, 20000: 70e6, 50000: 150e6, note: "mostly the nightly jobs and page renders; the hourly tiers refresh adds about 4,300 reads per site a month if it stays hourly" },
  "turso.write": { 5000: 0.6e6, 20000: 2.1e6, 50000: 5.2e6, note: "the nightly board (about 87 writes per site a month, ranks are dense) and one weekly snapshot (13)" },
  "turso.storage": { 5000: 0.15 * GB, 20000: 0.5 * GB, 50000: 1.2 * GB, note: "portfolios rows (page text and grade) are most of it" },
  "r2.storage": { 5000: 2.9 * GB, 20000: 4.5 * GB, 50000: 7.7 * GB, note: "106 KB of screenshots a site after full.jpg is dropped, plus the other apps' 2.4 GB; page caches of old builds not counted (see the audit)" },
  "r2.classA": { 5000: 0.06e6, 20000: 0.12e6, 50000: 0.25e6, note: "captures and page-cache writes" },
  "r2.classB": { 5000: 0.8e6, 20000: 1.0e6, 50000: 1.5e6, note: "screenshot reads are mostly answered by the edge cache" },
  "psi": { 5000: 400, 20000: 1100, 50000: 2600, note: "two runs per re-measure, every 90 days or on a page change" },
};

/** The calendar month (UTC) of a time, as YYYY-MM. */
const monthOf = (now) => new Date(now).toISOString().slice(0, 7);

async function rowsOrNull(db, stmt) {
  try {
    return (await db.execute(stmt)).rows;
  } catch (e) {
    if (/no such table/i.test(String(e?.message ?? e))) return null;
    throw e;
  }
}

export const SNAPSHOT_TABLE = `CREATE TABLE IF NOT EXISTS limit_snapshots (
  key TEXT PRIMARY KEY,
  used REAL NOT NULL,
  cap REAL,
  detail TEXT,
  at TEXT NOT NULL
)`;

/** Stores measured values: { key: { used, cap?, detail? } } at `at`. One row per key, replaced. */
export async function saveSnapshots(db, values, at = new Date().toISOString()) {
  await db.execute(SNAPSHOT_TABLE);
  const stmts = Object.entries(values)
    .filter(([, v]) => v && Number.isFinite(Number(v.used)))
    .map(([key, v]) => ({
      sql: `INSERT INTO limit_snapshots (key, used, cap, detail, at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET used = excluded.used, cap = excluded.cap, detail = excluded.detail, at = excluded.at`,
      args: [key, Number(v.used), v.cap == null ? null : Number(v.cap), v.detail == null ? null : JSON.stringify(v.detail), v.at ?? at],
    }));
  if (stmts.length) await db.batch(stmts, "write");
  return stmts.length;
}

/** The stored snapshots, key -> { used, cap, detail, at }; empty before the first one. */
export async function readSnapshots(db) {
  const rows = (await rowsOrNull(db, "SELECT key, used, cap, detail, at FROM limit_snapshots")) ?? [];
  const parse = (v) => {
    try {
      return v == null ? null : JSON.parse(String(v));
    } catch {
      return null;
    }
  };
  return Object.fromEntries(rows.map((r) => [String(r.key), { used: Number(r.used), cap: r.cap == null ? null : Number(r.cap), detail: parse(r.detail), at: String(r.at) }]));
}

/**
 * What the app counts itself, now: key -> { used, at }. Every read is a
 * primary-key lookup or an index range over today's (or this month's) rows,
 * except PageSpeed: the stored results' range of the cache table (about two
 * rows per site), read only when the admin opens the page.
 */
export async function liveUsage(db, { now = new Date(), model = "gemini-3.5-flash-lite" } = {}) {
  const at = new Date(now).toISOString();
  const { day, start, end } = quotaDay(new Date(now));
  const month = monthOf(now);
  const utcDay = at.slice(0, 10);
  const one = async (stmt, pick = (r) => Number(r?.n ?? 0)) => {
    const rows = await rowsOrNull(db, stmt);
    return rows == null ? null : pick(rows[0]);
  };
  const [gemini, psi, emailDay, emailMonth, neurons, tavily, pexels] = await Promise.all([
    one({ sql: "SELECT COUNT(*) AS n FROM gemini_requests WHERE at >= ? AND at < ? AND model = ?", args: [start.toISOString(), end.toISOString(), model] }),
    one({ sql: "SELECT COUNT(*) AS n FROM cache WHERE ((k >= 'psi:' AND k < 'psi;') OR (k >= 'psi-desktop:' AND k < 'psi-desktop;')) AND v != '' AND at >= ?", args: [start.getTime()] }),
    one({ sql: "SELECT COUNT(*) AS n FROM email_sends WHERE day = ?", args: [day] }),
    one({ sql: "SELECT COUNT(*) AS n FROM email_sends WHERE day >= ? AND day <= ?", args: [`${month}-01`, `${month}-31`] }),
    one({ sql: "SELECT COALESCE(SUM(neurons), 0) AS n FROM ai_image_calls WHERE day = ?", args: [utcDay] }),
    one({ sql: "SELECT used AS n FROM tavily_credits WHERE month = ?", args: [month] }),
    one({ sql: "SELECT used AS n FROM pexels_searches WHERE month = ?", args: [month] }),
  ]);
  const out = {};
  const put = (key, used) => {
    if (used != null) out[key] = { used, at };
  };
  put("gemini", gemini);
  put("psi", psi);
  put("email.day", emailDay);
  put("email.month", emailMonth);
  put("ai.neurons", neurons);
  put("tavily", tavily);
  put("pexels", pexels);
  return out;
}

/** "6.8M", "31 MB", "0.2M", "1.7B" -> a number. */
export function parseAmount(s) {
  const m = String(s).trim().match(/^([\d.]+)\s*([kKMGB]?B?|[KMB])?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toUpperCase();
  const scale = { "": 1, K: 1e3, M: 1e6, B: 1e9, KB: 1e3, MB: 1e6, GB: 1e9 }[unit];
  return scale == null ? null : n * scale;
}

/** The usage table of `turso plan show` -> { rowsRead, rowsWritten, storage }. */
export function parsePlanShow(text) {
  const row = (name) => {
    const line = text.split("\n").find((l) => l.trim().toLowerCase().startsWith(name));
    if (!line) return null;
    const cols = line.trim().split(/\s{2,}/);
    return parseAmount(cols[1]);
  };
  return { rowsRead: row("rows read"), rowsWritten: row("rows written"), storage: row("storage") };
}

/** How much of its calendar month (UTC) a time is into, 0 to 1. */
export function monthElapsed(at) {
  const t = new Date(at);
  const start = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1);
  const end = Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1);
  return (t.getTime() - start) / (end - start);
}

/** "ok", "warn" or "danger" for a share of a limit. */
export const levelOf = (share, warn = WARN) => (share >= Math.max(DANGER, warn) ? "danger" : share >= warn ? "warn" : "ok");

/**
 * The page's rows: each limit with what is used (null when it hasn't been
 * measured yet), the share, the level, when it was measured and whether that
 * is stale, and the projections. `caps` overrides a cap where the app's own
 * setting is lower than the provider's (Tavily, Pexels, Gemini quota).
 */
export function limitRows({ live = {}, snapshots = {}, caps = {}, now = new Date() }) {
  const t = new Date(now).getTime();
  return LIMITS.map((l) => {
    const m = l.source === "live" ? live[l.key] : snapshots[l.key];
    const cap = caps[l.key] ?? (l.source === "snapshot" && m?.cap ? m.cap : l.cap);
    const used = m ? m.used : null;
    const share = used == null || !(cap > 0) ? null : used / cap;
    const warn = l.warn ?? WARN;
    const stale = l.source === "snapshot" && m ? t - Date.parse(m.at) > STALE_MS : false;
    const p = PROJECTIONS[l.key];
    // A monthly count on its way past the limit warns before it gets there:
    // the month's pace, once a fifth of the month has gone by (earlier is noise).
    const elapsed = m && l.period === "month" ? monthElapsed(m.at) : null;
    const pace = share != null && elapsed != null && elapsed >= 0.2 ? share / elapsed : null;
    const shareLevel = share == null ? "unknown" : levelOf(share, warn);
    const paceLevel = pace == null ? "ok" : levelOf(pace, Math.max(warn, 0.9));
    const order = ["unknown", "ok", "warn", "danger"];
    return {
      ...l,
      cap,
      used,
      share,
      warn,
      pace,
      shareLevel,
      level: order.indexOf(paceLevel) > order.indexOf(shareLevel) && shareLevel !== "unknown" ? paceLevel : shareLevel,
      at: m?.at ?? null,
      stale,
      detail: m?.detail ?? null,
      projections: p ? SIZES.map((size) => ({ size, used: p[size], share: p[size] / cap, level: levelOf(p[size] / cap, warn) })) : null,
      projectionNote: p?.note ?? null,
    };
  });
}

/**
 * Everything the page and the API need: the rows, plus counts of warnings.
 * @param {import("@libsql/client").Client} db
 * @param {{ now?: Date, env?: Record<string, string | undefined>, model?: string }} [opts]
 */
export async function adminLimits(db, { now = new Date(), env = {}, model = undefined } = {}) {
  const [live, snapshots] = await Promise.all([liveUsage(db, { now, model }), readSnapshots(db)]);
  const caps = {};
  const num = (v) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  if (num(env.TAVILY_MONTHLY_CREDITS) != null) caps.tavily = Math.min(200, num(env.TAVILY_MONTHLY_CREDITS));
  if (num(env.PEXELS_MONTHLY_SEARCHES) != null) caps.pexels = Math.min(500, num(env.PEXELS_MONTHLY_SEARCHES));
  const rows = limitRows({ live, snapshots, caps, now });
  return {
    rows,
    warnings: rows.filter((r) => r.level === "warn").length,
    dangers: rows.filter((r) => r.level === "danger").length,
    unmeasured: rows.filter((r) => r.used == null).length,
    stale: rows.filter((r) => r.stale).length,
    snapshotAt: Object.values(snapshots).reduce((a, s) => (!a || s.at > a ? s.at : a), null),
  };
}
