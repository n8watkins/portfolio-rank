// The content engine's storage (docs/CONTENT-ENGINE.md, "Where posts live"
// and gate 6): the switch, the posts table with the weekly publish cap
// counted in the same write that publishes, the run log the caps count, and
// the admin read. Plain JavaScript: the Worker's night run, the admin API
// and the tests all import it.
import { pacificParts, pad, quotaDay } from "../../pipeline/quota-day.mjs";
import { pollWeek } from "../polls/week.mjs";

/** CONTENT_MODE values; anything else (or unset) is "off". */
export const MODES = ["off", "dry-run", "publish"];
/** Posts published in any 7 days, at most (gate 6). */
export const PUBLISH_CAP = 2;
const WEEK_MS = 7 * 86400000;

/** The kill switch: the Worker variable CONTENT_MODE, "off" unless it says otherwise. */
export function contentMode(value) {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  return MODES.includes(v) ? v : "off";
}

/** The short line under the title and the full note at the end (owner decision 5). */
export const AI_LINE = "Written with AI from PortfolioRank data.";
export function aiNote({ dataAsOf, dataLink }) {
  return [
    `This post was written with AI from PortfolioRank data, data as of ${dataAsOf.slice(0, 10)}.`,
    "Code computed every number and drew every chart; Gemini wrote the words around them, and code and a second Gemini pass checked them before publishing.",
    `The data behind it: ${dataLink}.`,
    "How these posts are made: /about-posts.",
  ].join("\n");
}

/**
 * The content week a night belongs to: the poll week (Monday to Monday,
 * Pacific) of the morning after, so Sunday night's pick serves the coming
 * Monday's and Wednesday's drafts.
 */
export function contentWeek(at) {
  return pollWeek(new Date(new Date(at).getTime() + 4 * 3600000)).id;
}

/** 08:00 Pacific on the morning after the night that contains `at`. */
export function nextMorning(at) {
  const end = quotaDay(new Date(at)).end; // the next midnight, Pacific
  const p = pacificParts(end);
  for (const offset of [15, 16]) {
    const t = new Date(Date.UTC(p.year, p.month - 1, p.day, offset));
    if (pacificParts(t).hour === 8) return t;
  }
  throw new Error(`no 08:00 Pacific on ${p.year}-${pad(p.month)}-${pad(p.day)}`);
}

const json = (v) => JSON.stringify(v ?? null);
const parse = (v, fallback) => {
  if (v == null) return fallback;
  try {
    return JSON.parse(String(v));
  } catch {
    return fallback;
  }
};

/** A URL-safe slug from a title, unique enough with the id's tail. */
export function slugify(title, id) {
  const base = String(title)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/, "");
  return `${base || "post"}-${String(id).slice(0, 6)}`;
}

/**
 * Stores a finished draft. In "publish" mode it is published at
 * `publishAt` only if fewer than PUBLISH_CAP posts are published within 7
 * days either side of it: the count and the insert are one statement, so
 * two writers can't both slip under the cap. A post the cap holds back is
 * stored as a draft. In "dry-run" mode it is always a draft (the private
 * queue). Returns { status, capped }.
 */
export async function storePost(db, post, { mode, publishAt, now }) {
  const at = new Date(now).toISOString();
  const cols = [
    "id", "slug", "kind", "status", "mode", "title", "subtitle", "alt_titles", "tags", "share_line", "newsletter_blurb",
    "ai_line", "ai_note", "body", "facts", "checks", "images", "claims", "data_as_of", "publish_at", "published_at",
    "newsletter_pending", "night", "run_id", "requests", "created_at", "updated_at",
  ];
  const values = (status, p = post) => [
    p.id, p.slug, p.kind, status, mode, p.title, p.subtitle ?? null, json(p.altTitles ?? []), json(p.tags ?? []),
    p.shareLine ?? null, p.newsletterBlurb ?? null, p.aiLine, p.aiNote, p.body, json(p.facts), json(p.checks),
    json(p.images ?? []), json(p.claims ?? []), p.dataAsOf, publishAt ? new Date(publishAt).toISOString() : null,
    status === "published" ? at : null, status === "published" ? 1 : 0, p.night ?? null, p.runId ?? null, p.requests ?? 0, at, at,
  ];
  const marks = cols.map(() => "?").join(", ");
  if (mode === "publish" && publishAt) {
    const p = new Date(publishAt).getTime();
    const res = await db.execute({
      sql: `INSERT INTO posts (${cols.join(", ")}) SELECT ${marks}
            WHERE (SELECT COUNT(*) FROM posts WHERE status = 'published' AND publish_at > ? AND publish_at < ?) < ?`,
      args: [...values("published"), new Date(p - WEEK_MS).toISOString(), new Date(p + WEEK_MS).toISOString(), PUBLISH_CAP],
    });
    if (res.rowsAffected > 0) return { status: "published", capped: false };
    const held = { ...post, checks: { ...post.checks, publishCap: `held: ${PUBLISH_CAP} posts already publish within 7 days` } };
    await db.execute({ sql: `INSERT INTO posts (${cols.join(", ")}) VALUES (${marks})`, args: values("draft", held) });
    return { status: "draft", capped: true };
  }
  await db.execute({ sql: `INSERT INTO posts (${cols.join(", ")}) VALUES (${marks})`, args: values(post.status ?? "draft") });
  return { status: post.status ?? "draft", capped: false };
}

/** One line in content_runs. */
export async function recordRun(db, { night, now, step, mode, status, kind = null, postId = null, gemini = 0, tavily = 0, imagesAi = 0, detail = {} }) {
  await db.execute({
    sql: `INSERT INTO content_runs (night, at, week, step, mode, status, kind, post_id, gemini, tavily, images_ai, detail)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [night, new Date(now).toISOString(), contentWeek(now), step, mode, status, kind, postId, gemini, tavily, imagesAi, json(detail)],
  });
}

/** Tavily searches in the 7 days before `now` (the weekly cap). */
export async function tavilyThisWeek(db, now) {
  const r = await db.execute({ sql: "SELECT COALESCE(SUM(tavily), 0) AS n FROM content_runs WHERE at > ?", args: [new Date(new Date(now).getTime() - WEEK_MS).toISOString()] });
  return Number(r.rows[0]?.n ?? 0);
}

/** content_runs rows of one week and step, oldest first. */
export async function runsOfWeek(db, week, step) {
  const r = await db.execute({ sql: "SELECT * FROM content_runs WHERE week = ? AND step = ? ORDER BY id", args: [week, step] });
  return r.rows.map((row) => ({ ...row, detail: parse(row.detail, {}) }));
}

/** A post row as the admin API returns it. */
export function postFromRow(r) {
  return {
    id: String(r.id),
    slug: String(r.slug),
    kind: String(r.kind),
    status: String(r.status),
    mode: String(r.mode),
    title: String(r.title),
    subtitle: r.subtitle == null ? null : String(r.subtitle),
    altTitles: parse(r.alt_titles, []),
    tags: parse(r.tags, []),
    shareLine: r.share_line == null ? null : String(r.share_line),
    newsletterBlurb: r.newsletter_blurb == null ? null : String(r.newsletter_blurb),
    aiLine: String(r.ai_line),
    aiNote: String(r.ai_note),
    body: String(r.body),
    facts: parse(r.facts, null),
    checks: parse(r.checks, null),
    images: parse(r.images, []),
    claims: parse(r.claims, []),
    dataAsOf: String(r.data_as_of),
    publishAt: r.publish_at == null ? null : String(r.publish_at),
    publishedAt: r.published_at == null ? null : String(r.published_at),
    newsletterPending: Number(r.newsletter_pending) === 1,
    night: r.night == null ? null : String(r.night),
    requests: Number(r.requests ?? 0),
    createdAt: String(r.created_at),
    updatedAt: r.updated_at == null ? null : String(r.updated_at),
  };
}

/** Posts for the admin view, newest first; `status` "all" or one status. */
export async function listPosts(db, { status = "draft", limit = 20 } = {}) {
  const where = status === "all" ? "" : "WHERE status = ?";
  const r = await db.execute({ sql: `SELECT * FROM posts ${where} ORDER BY created_at DESC, id LIMIT ?`, args: status === "all" ? [limit] : [status, limit] });
  return r.rows.map(postFromRow);
}

/** The latest content_runs rows, newest first. */
export async function recentRuns(db, { limit = 30 } = {}) {
  const r = await db.execute({ sql: "SELECT * FROM content_runs ORDER BY id DESC LIMIT ?", args: [limit] });
  return r.rows.map((row) => ({
    night: String(row.night),
    at: String(row.at),
    week: String(row.week),
    step: String(row.step),
    mode: String(row.mode),
    status: String(row.status),
    kind: row.kind == null ? null : String(row.kind),
    postId: row.post_id == null ? null : String(row.post_id),
    gemini: Number(row.gemini),
    tavily: Number(row.tavily),
    imagesAi: Number(row.images_ai),
    detail: parse(row.detail, {}),
  }));
}
