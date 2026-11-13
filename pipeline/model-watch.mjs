// Model watch (owner decision 2026-11-10: "just news"): once a week, read
// Google's own Gemini sources, compare them with the last snapshot in the
// database and tell the owner what changed. It never changes a setting:
// switching the judge is always a config change by the owner, after an
// experiment.
//
// Sources, all official and all free (AUTOMATION.md "Model watch"):
//   models.list  GET /v1beta/models with the key in x-goog-api-key. A
//                metadata call: no model, no tokens, so it can't use any
//                model's generate quota, and it is never logged in
//                gemini_requests (the budget accountant's ledger).
//   deprecations the deprecations page: release and shutdown dates and
//                replacements, per model.
//   changelog    the release notes page, one section per date.
// Google serves the docs pages as Markdown (the source of the HTML pages);
// a page that stops parsing counts as a failed source, never as "every
// model was retired".
//
// The report: new models, retired or deprecated ones (with dates), changes
// to Flash-Lite models, new release notes, and the status of the models in
// use (PRIMARY_MODEL for grades and comparisons, BACKUP_MODEL for labelled
// experiments). It goes to the owner through the owner alerts
// (pipeline/alerts.mjs), keys "model-watch:*", and to the admin quota API.
import { MODEL_WATCH_TABLES, applyTables } from "../lib/pipeline-schema.mjs";
import { BACKUP_MODEL, GEMINI_API_BASE, PRIMARY_MODEL } from "./gemini.mjs";

export const MODELS_URL = `${GEMINI_API_BASE}/models`;
export const DEPRECATIONS_URL = "https://aistudio.google.com/docs/deprecations";
export const CHANGELOG_URL = "https://aistudio.google.com/docs/changelog";

/** The models PortfolioRank uses, and what for. */
export const IN_USE = [
  { model: PRIMARY_MODEL, role: "grades and ranking comparisons" },
  { model: BACKUP_MODEL, role: "labelled experiments only" },
];

/** An in-use model whose shutdown date is this close (or past) holds a problem alert every week. */
export const SHUTDOWN_WARNING_DAYS = 90;
/** Fewer models than this in models.list means the answer is broken, not that Google retired everything. */
export const MIN_MODELS = 10;
export const ALERT_PREFIX = "model-watch:";
export const isModelWatchAlert = (key) => String(key).startsWith(ALERT_PREFIX);
const FETCH_TIMEOUT_MS = 30_000;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export async function ensureModelWatchSchema(db) {
  await applyTables(db, MODEL_WATCH_TABLES);
}

/** "November 17, 2026" -> "2026-11-17"; anything else -> null. */
export function isoDate(text) {
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

// A short, stable fingerprint of a text (FNV-1a), to notice an edited section.
function fingerprint(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const unticked = (s) => s.replace(/`/g, "").replace(/\s+/g, " ").trim();

/** models.list's answer -> { id: { displayName, version, inputTokenLimit, outputTokenLimit, methods, thinking } }. */
export function parseModels(json) {
  const out = {};
  for (const m of json?.models ?? []) {
    const id = String(m?.name ?? "").replace(/^models\//, "");
    if (!id) continue;
    out[id] = {
      displayName: m.displayName ?? null,
      version: m.version ?? null,
      inputTokenLimit: m.inputTokenLimit ?? null,
      outputTokenLimit: m.outputTokenLimit ?? null,
      methods: [...(m.supportedGenerationMethods ?? [])].sort().join(","),
      thinking: m.thinking === true,
    };
  }
  return out;
}

/**
 * The deprecations page (Markdown with Markdoc tables) -> { id: { group,
 * status, release, shutdown, shutdownText, replacement } }. status is
 * "deprecated" under a "Deprecated ..." heading, "preview" under a "Preview
 * ..." heading, else "current". shutdown is an ISO date or null ("No
 * shutdown date announced", "N/A").
 */
export function parseDeprecations(md) {
  const out = {};
  let group = "";
  let sub = "";
  const lines = String(md ?? "").split("\n");
  let row = null;
  let cell = -1;
  let inTable = false;
  let header = true;
  const flush = () => {
    if (!row || header) return;
    const cells = row.map((c) => unticked(c));
    const id = cells[0]?.split(" ")[0];
    if (!id || !/^[a-z0-9][a-z0-9.\-_]*$/i.test(id)) return;
    const status = /deprecated/i.test(sub) ? "deprecated" : /preview/i.test(sub) ? "preview" : "current";
    out[id] = { group, status, release: isoDate(cells[1]) ?? cells[1] ?? null, shutdown: isoDate(cells[2]), shutdownText: cells[2] ?? "", replacement: cells[3] || null };
  };
  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*(\{%.*%\})?\s*$/.exec(line);
    const h3 = /^###\s+(.+?)\s*(\{%.*%\})?\s*$/.exec(line);
    if (h3) {
      sub = h3[1];
      continue;
    }
    if (h2 && !line.startsWith("###")) {
      group = h2[1];
      sub = "";
      continue;
    }
    if (/\{%\s*table\s*%\}/.test(line)) {
      inTable = true;
      header = true;
      row = [];
      cell = -1;
      continue;
    }
    if (!inTable) continue;
    if (/\{%\s*\/table\s*%\}/.test(line)) {
      flush();
      inTable = false;
      row = null;
      continue;
    }
    if (/^\s*---\s*$/.test(line)) {
      flush();
      header = false;
      row = [];
      cell = -1;
      continue;
    }
    const start = /^ {2}\* ?(.*)$/.exec(line);
    if (start) {
      cell += 1;
      row[cell] = start[1];
    } else if (cell >= 0 && line.trim()) {
      row[cell] += " " + line.trim();
    }
  }
  return out;
}

/**
 * The release notes page -> [{ date, titles, models, text: fingerprint }],
 * newest first. titles are the bold lead-ins of the top-level bullets;
 * models are the backticked model ids the section names.
 */
export function parseChangelog(md) {
  const sections = [];
  let cur = null;
  for (const line of String(md ?? "").split("\n")) {
    const h = /^##\s+([A-Za-z]+ \d{1,2}, \d{4})\b/.exec(line);
    if (h) {
      cur = { date: isoDate(h[1]), lines: [] };
      if (cur.date) sections.push(cur);
      else cur = null;
      continue;
    }
    if (/^#\s/.test(line) || /^##\s/.test(line)) {
      cur = null;
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  return sections.map(({ date, lines }) => {
    const body = lines.join("\n").trim();
    const titles = [];
    for (const l of lines) {
      const t = /^\*\s+\*\*(.+?)\*\*/.exec(l);
      if (t) titles.push(unticked(t[1]).replace(/:$/, ""));
    }
    const models = [...new Set([...body.matchAll(/`((?:gemini|gemma|imagen|veo|lyria|nano-banana)[a-z0-9.\-_]*)`/gi)].map((m) => m[1].toLowerCase()))];
    return { date, titles, models, text: fingerprint(body.replace(/\s+/g, " ")), lower: body.toLowerCase() };
  });
}

async function fetchWith(fetchImpl, url, init) {
  const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
  const res = await fetchImpl(url, { ...init, signal });
  if (!res.ok) throw new Error(`${new URL(url).host}${new URL(url).pathname} answered HTTP ${res.status}`);
  return res;
}

/**
 * Reads the three sources. Each one can fail on its own; a failed source
 * is { ok: false, error } and keeps last week's snapshot.
 * @param {{ apiKey?: string, fetchImpl?: typeof fetch }} options
 */
export async function readSources({ apiKey, fetchImpl = (u, i) => fetch(u, i) } = {}) {
  const one = async (read) => {
    try {
      return { ok: true, ...(await read()) };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
    }
  };
  const models = await one(async () => {
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    const all = { models: [] };
    let token = "";
    for (let page = 0; page < 10; page++) {
      const u = new URL(MODELS_URL);
      u.searchParams.set("pageSize", "1000");
      if (token) u.searchParams.set("pageToken", token);
      // The key in the header, never in the URL (pipeline/gemini.mjs).
      const json = await (await fetchWith(fetchImpl, u.toString(), { headers: { "x-goog-api-key": apiKey } })).json();
      all.models.push(...(json.models ?? []));
      token = json.nextPageToken ?? "";
      if (!token) break;
    }
    const data = parseModels(all);
    const n = Object.keys(data).length;
    if (n < MIN_MODELS) throw new Error(`models.list returned ${n} model(s), fewer than ${MIN_MODELS}: treated as a broken answer`);
    return { data };
  });
  const md = { headers: { accept: "text/markdown" } };
  const deprecations = await one(async () => {
    const data = parseDeprecations(await (await fetchWith(fetchImpl, DEPRECATIONS_URL, md)).text());
    if (Object.keys(data).length < MIN_MODELS) throw new Error("the deprecations page no longer parses (its format changed?)");
    return { data };
  });
  const changelog = await one(async () => {
    const data = parseChangelog(await (await fetchWith(fetchImpl, CHANGELOG_URL, md)).text());
    if (!data.length) throw new Error("the release notes page no longer parses (its format changed?)");
    return { data };
  });
  return { models, deprecations, changelog };
}

/**
 * This week's snapshot: the sources that worked, last week's for the rest.
 * Changelog sections are kept as { date: fingerprint } plus their titles.
 */
export function snapshotOf(sources, previous = null) {
  const keep = (key, fresh) => (sources[key].ok ? fresh(sources[key].data) : previous?.[key] ?? null);
  return {
    models: keep("models", (d) => d),
    deprecations: keep("deprecations", (d) => d),
    changelog: keep("changelog", (d) => Object.fromEntries(d.map((s) => [s.date, s.text]))),
  };
}

const flashLite = (id) => /flash-lite/i.test(id);
const daysUntil = (iso, now) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(now.toISOString().slice(0, 10) + "T00:00:00Z")) / 86_400_000);

/**
 * @typedef {{ ranAt: string, baseline: string[], sources: Record<string, { ok: boolean, count?: number, error?: string }>,
 *   newModels: any[], retired: any[], changed: any[], flashLite: string[], changelog: any[], inUse: any[], changes: number }} WatchReport
 */

/**
 * Compares this week's sources with the previous snapshot. A source seen
 * for the first time (no previous snapshot of it) is a baseline: recorded,
 * not reported as hundreds of "new" models.
 * @returns {WatchReport} the report (plain JSON)
 */
export function buildReport(sources, previous, { now = new Date(), inUse = IN_USE } = {}) {
  /** @type {WatchReport} */
  const report = {
    ranAt: now.toISOString(),
    baseline: [],
    sources: Object.fromEntries(
      Object.entries(sources).map(([k, s]) => [k, s.ok ? { ok: true, count: Array.isArray(s.data) ? s.data.length : Object.keys(s.data).length } : { ok: false, error: s.error }])
    ),
    newModels: [],
    retired: [],
    changed: [],
    flashLite: [],
    changelog: [],
    inUse: [],
    changes: 0,
  };
  const fresh = (key) => sources[key].ok && previous?.[key];
  for (const key of ["models", "deprecations", "changelog"]) if (sources[key].ok && !previous?.[key]) report.baseline.push(key);

  // models.list
  if (fresh("models")) {
    const was = previous.models;
    const now_ = sources.models.data;
    for (const id of Object.keys(now_)) if (!was[id]) report.newModels.push({ id, displayName: now_[id].displayName, source: "model list" });
    for (const id of Object.keys(was)) if (!now_[id]) report.retired.push({ id, what: "no longer in the model list" });
    for (const id of Object.keys(now_)) {
      if (!was[id]) continue;
      for (const field of ["version", "displayName", "inputTokenLimit", "outputTokenLimit", "methods", "thinking"]) {
        if (String(was[id][field]) !== String(now_[id][field])) report.changed.push({ id, field, from: was[id][field], to: now_[id][field] });
      }
    }
  }
  // deprecations
  if (fresh("deprecations")) {
    const was = previous.deprecations;
    const now_ = sources.deprecations.data;
    const listedNew = new Set(report.newModels.map((m) => m.id));
    for (const id of Object.keys(now_)) {
      const d = now_[id];
      if (!was[id]) {
        if (d.status === "deprecated") report.retired.push({ id, what: `listed as shut down on ${d.shutdownText}`, shutdown: d.shutdown, replacement: d.replacement });
        else if (!listedNew.has(id)) report.newModels.push({ id, displayName: null, source: "deprecations page", release: d.release });
        else Object.assign(report.newModels.find((m) => m.id === id), { release: d.release });
        continue;
      }
      const w = was[id];
      if (w.status !== "deprecated" && d.status === "deprecated") {
        report.retired.push({ id, what: `moved to the deprecated models (shutdown ${d.shutdownText})`, shutdown: d.shutdown, replacement: d.replacement });
      } else if (w.shutdownText !== d.shutdownText) {
        report.retired.push({
          id,
          what: d.shutdown ? `shutdown date ${w.shutdown ? `moved from ${w.shutdownText} to` : "set:"} ${d.shutdownText}` : `shutdown changed from "${w.shutdownText}" to "${d.shutdownText}"`,
          shutdown: d.shutdown,
          replacement: d.replacement,
        });
      } else if ((w.replacement ?? "") !== (d.replacement ?? "")) {
        report.changed.push({ id, field: "replacement", from: w.replacement, to: d.replacement });
      }
      if (w.status !== d.status && !(w.status !== "deprecated" && d.status === "deprecated")) report.changed.push({ id, field: "status", from: w.status, to: d.status });
    }
    for (const id of Object.keys(was)) if (!now_[id]) report.changed.push({ id, field: "deprecations page", from: "listed", to: "no longer listed" });
  }
  // changelog: new dated sections, and sections edited since last week
  if (fresh("changelog")) {
    const was = previous.changelog;
    for (const s of sources.changelog.data) {
      if (was[s.date] === s.text) continue;
      const mentionsInUse = inUse.filter((u) => s.models.includes(u.model) || s.lower.includes(u.model)).map((u) => u.model);
      report.changelog.push({ date: s.date, edited: Boolean(was[s.date]), titles: s.titles, models: s.models, inUse: mentionsInUse, link: `${CHANGELOG_URL}#${s.date.slice(5, 7)}-${s.date.slice(8, 10)}-${s.date.slice(0, 4)}` });
    }
  }
  // Flash-Lite: every change above that names a Flash-Lite model.
  for (const m of report.newModels) if (flashLite(m.id)) report.flashLite.push(`New: ${m.id}${m.release ? ` (released ${m.release})` : ""}`);
  for (const r of report.retired) if (flashLite(r.id)) report.flashLite.push(`${r.id}: ${r.what}${r.replacement ? `; replacement ${r.replacement}` : ""}`);
  for (const c of report.changed) if (flashLite(c.id)) report.flashLite.push(`${c.id}: ${c.field} ${c.from ?? "-"} -> ${c.to ?? "-"}`);
  for (const c of report.changelog) {
    const lite = c.models.filter(flashLite);
    if (lite.length) report.flashLite.push(`Release notes ${c.date}: ${c.titles.join("; ") || "(no title)"} (${lite.join(", ")})`);
  }

  // The models in use: their status this week, whatever changed.
  const models = sources.models.ok ? sources.models.data : previous?.models ?? null;
  const deps = sources.deprecations.ok ? sources.deprecations.data : previous?.deprecations ?? null;
  for (const u of inUse) {
    const listed = models ? Boolean(models[u.model]) : null;
    const d = deps?.[u.model] ?? null;
    const days = d?.shutdown ? daysUntil(d.shutdown, now) : null;
    const notes = [];
    if (listed === false) notes.push("not in Google's model list");
    if (d?.status === "deprecated") notes.push("listed as a deprecated model");
    if (days != null) notes.push(days < 0 ? `shutdown date ${d.shutdown} has passed` : `shutdown on ${d.shutdown} at the earliest (${days} days)`);
    const touched = [...report.retired, ...report.changed, ...report.newModels].some((x) => x.id === u.model) || report.changelog.some((c) => c.inUse.includes(u.model));
    report.inUse.push({
      model: u.model,
      role: u.role,
      listed,
      version: models?.[u.model]?.version ?? null,
      release: d?.release ?? null,
      shutdown: d?.shutdown ?? null,
      shutdownText: d?.shutdownText ?? null,
      replacement: d?.replacement ?? null,
      changedThisWeek: touched,
      warning: listed === false || d?.status === "deprecated" || (days != null && days <= SHUTDOWN_WARNING_DAYS),
      notes,
    });
  }
  report.changes = report.newModels.length + report.retired.length + report.changed.length + report.changelog.length;
  return report;
}

/** The report in plain words, for the alert email and the logs. */
export function reportText(report) {
  const out = [];
  const date = report.ranAt.slice(0, 10);
  if (report.baseline.length) out.push(`First look at ${report.baseline.join(", ")}: recorded as the baseline, so nothing there is reported as new this week.`);
  const failed = Object.entries(report.sources).filter(([, s]) => !s.ok);
  for (const [k, s] of failed) out.push(`Could not read the ${k} source: ${s.error}. Last week's copy was kept.`);
  out.push("", "Models in use:");
  for (const u of report.inUse) {
    const bits = [u.listed === false ? "NOT in the model list" : u.listed ? `listed${u.version ? ` (version ${u.version})` : ""}` : "model list unknown"];
    if (u.release) bits.push(`released ${u.release}`);
    bits.push(u.shutdown ? `shutdown ${u.shutdown} at the earliest` : u.shutdownText ? u.shutdownText.toLowerCase() : "not on the deprecations page");
    if (u.replacement) bits.push(`replacement ${u.replacement}`);
    out.push(`- ${u.model} (${u.role}): ${bits.join(", ")}${u.warning ? ". ACTION: plan a move." : "."}${u.changedThisWeek ? " Changed this week." : ""}`);
  }
  const section = (title, rows) => {
    if (!rows.length) return;
    out.push("", `${title}:`);
    for (const r of rows) out.push(`- ${r}`);
  };
  section("New models", report.newModels.map((m) => `${m.id}${m.displayName ? ` (${m.displayName})` : ""}${m.release ? `, released ${m.release}` : ""}, from the ${m.source}`));
  section("Retired or deprecated", report.retired.map((r) => `${r.id}: ${r.what}${r.replacement ? `; replacement ${r.replacement}` : ""}`));
  section("Flash-Lite", report.flashLite);
  section("Other changes", report.changed.filter((c) => !flashLite(c.id)).map((c) => `${c.id}: ${c.field} ${c.from ?? "-"} -> ${c.to ?? "-"}`));
  section(
    "Release notes",
    report.changelog.map((c) => `${c.date}${c.edited ? " (edited)" : ""}: ${c.titles.join("; ") || "(no title)"}${c.inUse.length ? ` [mentions ${c.inUse.join(", ")}]` : ""} ${c.link}`)
  );
  if (!report.changes && !report.baseline.length) out.push("", "No changes since last week.");
  out.push("", `Model watch, ${date}. It only reports: no setting was changed.`);
  return out.join("\n").trim();
}

/** The owner-alert conditions this report holds (keys "model-watch:*"). */
export function watchConditions(report) {
  const out = [];
  if (report.changes || report.baseline.length) {
    out.push({
      key: `${ALERT_PREFIX}report`,
      kind: "news",
      title: report.baseline.length && !report.changes ? "Gemini model watch is running (baseline recorded)" : `Gemini model watch: ${report.changes} change(s) this week`,
      detail: reportText(report),
    });
  }
  for (const u of report.inUse) {
    if (!u.warning) continue;
    out.push({
      key: `${ALERT_PREFIX}in-use:${u.model}`,
      kind: "problem",
      title: `${u.model} (${u.role}) is being retired or is missing`,
      detail: `${u.notes.join("; ")}.${u.replacement ? ` Google's replacement: ${u.replacement}.` : ""} Nothing switches on its own: run the replacement as an experiment, then change the model in config.`,
    });
  }
  for (const [k, s] of Object.entries(report.sources)) {
    if (s.ok) continue;
    out.push({ key: `${ALERT_PREFIX}source:${k}`, kind: "problem", title: `Model watch could not read the ${k} source`, detail: `${s.error}. The rest of the report used last week's copy.` });
  }
  return out;
}

/** The previous snapshot (the latest run's), or null. */
export async function lastSnapshot(db) {
  await ensureModelWatchSchema(db);
  const row = (await db.execute("SELECT snapshot FROM model_watch_runs ORDER BY id DESC LIMIT 1")).rows[0];
  if (!row) return null;
  try {
    return JSON.parse(String(row.snapshot));
  } catch {
    return null;
  }
}

/**
 * The weekly run: read, compare, store, alert. Never throws for a source
 * failure; writes nothing but model_watch_runs and owner_alerts.
 * @param {{ db: { execute: Function }, apiKey?: string, fetchImpl?: typeof fetch, now?: Date,
 *   reconcile: (conditions: { key: string, kind: string, title: string, detail?: string }[]) => Promise<unknown>,
 *   log?: (line: string) => void, dryRun?: boolean }} ctx
 */
export async function runModelWatch({ db, apiKey, fetchImpl, now = new Date(), reconcile, log = () => {}, dryRun = false }) {
  const previous = await lastSnapshot(db);
  const sources = await readSources({ apiKey, fetchImpl });
  const report = buildReport(sources, previous, { now });
  const snapshot = snapshotOf(sources, previous);
  const failed = Object.values(sources).filter((s) => !s.ok).length;
  const status = failed === 0 ? "ok" : failed === 3 ? "failed" : "partial";
  const conditions = watchConditions(report);
  log(reportText(report));
  if (dryRun) return { status, report, conditions, alerts: null };
  await db.execute({
    sql: "INSERT INTO model_watch_runs (ran_at, status, changes, snapshot, report) VALUES (?, ?, ?, ?, ?)",
    args: [report.ranAt, status, report.changes, JSON.stringify(snapshot), JSON.stringify(report)],
  });
  // Keep a year of weekly runs.
  await db.execute("DELETE FROM model_watch_runs WHERE id NOT IN (SELECT id FROM model_watch_runs ORDER BY id DESC LIMIT 60)");
  const alerts = await reconcile(conditions);
  return { status, report, conditions, alerts };
}

/** The latest report and the recent runs, for the admin quota API. */
export async function modelWatchSummary(db, { limit = 8 } = {}) {
  const res = await db.execute({ sql: "SELECT ran_at, status, changes, report FROM model_watch_runs ORDER BY id DESC LIMIT ?", args: [limit] });
  if (!res.rows.length) return { latest: null, runs: [] };
  let latest = null;
  try {
    latest = JSON.parse(String(res.rows[0].report));
    latest.text = reportText(latest);
  } catch {
    latest = null;
  }
  return { latest, runs: res.rows.map((r) => ({ ranAt: String(r.ran_at), status: String(r.status), changes: Number(r.changes) })) };
}
