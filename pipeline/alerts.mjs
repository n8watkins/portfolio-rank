// Owner alerts that repeat until resolved (owner decision 2026-11-10).
//
// Each condition has a stable key. While it holds, the owner gets one email
// per quota day (Pacific) about it, every day, until it clears; never more
// than one per condition per day, and never once-and-forget. The state is
// the owner_alerts table, which the admin quota API also shows.
//
// Conditions, checked after every end-of-day run (worker/night.ts):
//   quota-before-night       the day's 3.5 quota was used up (down to the
//                            reserve) before the end-of-day run started
//   circuit-breaker:<stage>  a stage stopped after failures in a row
//   parked                   items failed 3 nights in a row and are parked
//   traction:people-grades   people's grade requests that day passed a level
//   traction:human-votes     human face-off votes that day passed a level
//                            ("PortfolioRank is doing well")
// Levels: ALERT_TRACTION (JSON, {"peopleGrades": 50, "humanVotes": 300}).
//
// Email: one interface, { send({ to, subject, text }) }, which throws when
// the email was not sent. It is Cloudflare Email Service behind the shared
// email gate with its hard caps (lib/email/gate.mjs, kind "owner-alert"),
// to OWNER_EMAIL, the owner's verified address (sends there are free). With
// no send_email binding, EMAIL_FROM or OWNER_EMAIL the sender is null:
// alerts are recorded and logged but not delivered, and a day's alert is
// only marked sent once the email went out.
import { quotaDay } from "./quota-day.mjs";
import { createEmailGate, emailCaps, emailTransport } from "../lib/email/gate.mjs";

export const DEFAULT_TRACTION = { peopleGrades: 50, humanVotes: 300 };

export function tractionLevels(raw = globalThis.process?.env?.ALERT_TRACTION) {
  try {
    return { ...DEFAULT_TRACTION, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return DEFAULT_TRACTION;
  }
}

/**
 * The line at the foot of every owner alert, so it is plain which system
 * sent it: site alerts go through Cloudflare Email Service, the newsletter
 * through Kit.
 * @param {string | null | undefined} from EMAIL_FROM
 */
export function alertFooter(from) {
  return `Site alert from PortfolioRank, sent through Cloudflare Email Service from ${from || "EMAIL_FROM"}. Newsletters go through Kit.`;
}

/**
 * The owner-alert sender: the shared email gate over the Worker's send_email
 * binding, or null while the binding, EMAIL_FROM or OWNER_EMAIL is missing.
 * `send` throws when the gate refused or the provider failed, so the alert
 * stays unsent for the day. Every email ends with alertFooter.
 * @param {any} env
 * @param {{ db?: { execute: Function, transaction: Function } }} [options]
 * @returns {null | { send(m: { to: string, subject: string, text: string, attachments?: import("../lib/email/gate.mjs").EmailAttachment[] }): Promise<void> }}
 */
export function emailSender(env, { db } = {}) {
  if (!db || !env?.OWNER_EMAIL) return null;
  const transport = emailTransport(env, { db });
  if (!transport) return null;
  const gate = createEmailGate({ db, transport, caps: emailCaps(env.EMAIL_CAPS), secret: env.AUTH_SECRET ?? globalThis.process?.env?.AUTH_SECRET });
  const footer = alertFooter(env.EMAIL_FROM);
  return {
    async send({ to, subject, text, attachments }) {
      const r = await gate.send({ kind: "owner-alert", to, subject, text: `${text}\n\n--\n${footer}\n`, attachments });
      if (!r.sent) throw new Error(`owner alert email not sent (${r.reason})`);
    },
  };
}

export async function ensureAlertSchema(db) {
  await db.execute(`CREATE TABLE IF NOT EXISTS owner_alerts (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    last_sent_day TEXT,
    sends INTEGER NOT NULL DEFAULT 0,
    cleared_at TEXT
  )`);
}

/** The conditions an end-of-day run's summary (pipeline/night.mjs finishNight) shows. */
export function nightConditions(summary, plan) {
  const out = [];
  const reserve = plan.reserve;
  if (summary.estimate && summary.estimate.quotaLeft <= reserve) {
    out.push({
      key: "quota-before-night",
      kind: "problem",
      title: "Gemini 3.5's quota was used up before the end-of-day run",
      detail: `On ${summary.night} only ${summary.estimate.quotaLeft} request(s) were left at the start of the run (reserve ${reserve}); background work waited. People may be using more than the free quota allows.`,
    });
  }
  for (const s of summary.stages ?? []) {
    if (/^circuit breaker/.test(s.result ?? "")) {
      out.push({ key: `circuit-breaker:${s.key}`, kind: "problem", title: `${s.label} stopped by the circuit breaker`, detail: `On ${summary.night}: ${s.result}` });
    }
  }
  if (summary.parked?.length) {
    out.push({
      key: "parked",
      kind: "problem",
      title: `${summary.parked.length} item(s) parked after failing 3 nights in a row`,
      detail: summary.parked.map((p) => `${p.job}: ${p.item} (${p.reason})`).join("\n"),
    });
  }
  return out;
}

/** Traction for the quota day that contains `now`: people's grade requests and human votes. */
export async function tractionConditions(db, { now = new Date(), levels = tractionLevels() } = {}) {
  const { day, start, end } = quotaDay(now);
  const range = [start.toISOString(), end.toISOString()];
  const count = async (sql, args) => {
    try {
      return Number((await db.execute({ sql, args })).rows[0]?.n ?? 0);
    } catch {
      return 0; // a table that doesn't exist yet
    }
  };
  const grades = await count("SELECT COUNT(*) AS n FROM people_requests WHERE created_at >= ? AND created_at < ?", range);
  // votes.created_at is SQLite's "YYYY-MM-DD HH:MM:SS" in UTC.
  const sqlite = (d) => d.toISOString().replace("T", " ").slice(0, 19);
  const votes = await count("SELECT COUNT(*) AS n FROM votes WHERE rater_type = 'human' AND created_at >= ? AND created_at < ?", [sqlite(start), sqlite(end)]);
  const out = [];
  if (grades >= levels.peopleGrades) {
    out.push({ key: "traction:people-grades", kind: "good", title: "PortfolioRank is doing well: grade requests", detail: `${grades} grade request(s) on ${day} (level ${levels.peopleGrades}).` });
  }
  if (votes >= levels.humanVotes) {
    out.push({ key: "traction:human-votes", kind: "good", title: "PortfolioRank is doing well: human votes", detail: `${votes} human face-off vote(s) on ${day} (level ${levels.humanVotes}).` });
  }
  return out;
}

/**
 * Records `conditions` (all that hold now among the keys `scope` covers),
 * sends each one that wasn't sent today, and clears the ones in scope that
 * no longer hold. Returns { sent, unsent, active, cleared }.
 * @param {{ execute: Function }} db
 * @param {{ conditions: { key: string, kind: string, title: string, detail?: string }[], scope?: (key: string) => boolean, now?: Date,
 *   email?: null | { send(m: { to: string, subject: string, text: string }): Promise<void> }, to?: string | null, log?: (line: string) => void }} options
 */
export async function reconcileAlerts(db, { conditions, scope = () => true, now = new Date(), email = null, to = null, log = () => {} }) {
  await ensureAlertSchema(db);
  const at = now.toISOString();
  const day = quotaDay(now).day;
  const holding = new Set(conditions.map((c) => c.key));
  const out = { sent: [], unsent: [], active: [...holding], cleared: [] };
  for (const c of conditions) {
    await db.execute({
      sql: `INSERT INTO owner_alerts (key, kind, title, detail, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, title = excluded.title, detail = excluded.detail, last_seen = excluded.last_seen,
              first_seen = CASE WHEN owner_alerts.cleared_at IS NULL THEN owner_alerts.first_seen ELSE excluded.first_seen END,
              cleared_at = NULL`,
      args: [c.key, c.kind, c.title, c.detail ?? "", at, at],
    });
    const row = (await db.execute({ sql: "SELECT last_sent_day, first_seen FROM owner_alerts WHERE key = ?", args: [c.key] })).rows[0];
    if (row?.last_sent_day === day) continue; // one email per condition per day
    if (!email || !to) {
      out.unsent.push(c.key);
      log(`owner alert (email off, no provider set up): ${c.title}`);
      continue;
    }
    const since = quotaDay(new Date(String(row?.first_seen ?? at))).day;
    try {
      await email.send({
        to,
        subject: `${c.kind === "good" ? "" : "[PortfolioRank] "}${c.title}`,
        text: `${c.detail ?? ""}\n\nOngoing since ${since}. This email repeats once a day until it clears.`,
      });
    } catch (e) {
      // Refused by the email gate's caps or failed at the provider: tried again on the next run.
      out.unsent.push(c.key);
      log(`owner alert not emailed: ${c.title} (${String(e?.message ?? e).slice(0, 120)})`);
      continue;
    }
    await db.execute({ sql: "UPDATE owner_alerts SET last_sent_day = ?, sends = sends + 1 WHERE key = ?", args: [day, c.key] });
    out.sent.push(c.key);
  }
  const open = (await db.execute("SELECT key FROM owner_alerts WHERE cleared_at IS NULL")).rows.map((r) => String(r.key));
  for (const key of open) {
    if (holding.has(key) || !scope(key)) continue;
    await db.execute({ sql: "UPDATE owner_alerts SET cleared_at = ? WHERE key = ?", args: [at, key] });
    out.cleared.push(key);
  }
  return out;
}

/** Alerts that hold now, for the admin view. */
export async function activeAlerts(db) {
  const res = await db.execute("SELECT key, kind, title, detail, first_seen, last_seen, last_sent_day, sends FROM owner_alerts WHERE cleared_at IS NULL ORDER BY first_seen");
  return res.rows.map((r) => ({ ...r, sends: Number(r.sends) }));
}
