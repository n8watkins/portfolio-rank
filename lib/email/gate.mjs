// The one email gate (owner decision 2026-11-10, "All email goes through one
// shared gate with hard caps"): grade reports, the games' report links,
// owner alerts and, later, the newsletter all send through send() here,
// which counts every send in
// email_sends and refuses once a daily cap is reached. No bug or abuse can
// send unbounded email.
//
// Caps (EMAIL_CAPS, JSON over DEFAULT_EMAIL_CAPS), per Pacific day like the
// Gemini quota:
//   day           every email of every kind; kept under Cloudflare Email
//                 Service's beta daily sending limit for new accounts
//   perRecipient  emails to one address (anti-flood: nobody can be mailed
//                 more than this many times a day through the site)
//   kinds         per kind ("grade-report", "report-link", "owner-alert", ...)
//   reserve       per kind, part of `day` no other kind may use (finished
//                 grade reports and owner alerts get theirs whoever else
//                 asks for email that day)
// A send that is refused or fails still counts, so a broken provider can't
// turn into a retry storm. At 80% of any cap the owner is alerted
// (emailCapConditions, hourly in worker/email-alerts.ts).
//
// The transport is Cloudflare Email Service: the Worker's send_email binding
// (SEND_EMAIL in wrangler.jsonc) from EMAIL_FROM, an address on n8builds.dev,
// which is onboarded for sending. Without the binding there is no transport
// and every send is refused as "no_transport". Test runs set
// EMAIL_TRANSPORT=outbox (honoured only with SITE_ENV "test") and the emails land in
// the email_outbox table instead.
//
// email_sends keeps no address: only a keyed hash, for the per-recipient cap.
import { createHmac } from "node:crypto";
import { testStandInsAllowed } from "../test-mode.mjs";
import { quotaDay } from "../../pipeline/quota-day.mjs";

export const DEFAULT_EMAIL_CAPS = {
  day: 100,
  perRecipient: 3,
  kinds: { "grade-report": 80, "report-link": 40, "owner-alert": 20 },
  // Held back from the day's total for one kind: no other kind may use
  // these, so strangers asking for report links can't spend the day's
  // emails before finished grade reports (and owner alerts) go out.
  reserve: { "grade-report": 30, "owner-alert": 10 },
};

/** @param {string | undefined} [raw] */
export function emailCaps(raw = globalThis.process?.env?.EMAIL_CAPS) {
  try {
    const over = raw ? JSON.parse(raw) : {};
    return {
      ...DEFAULT_EMAIL_CAPS,
      ...over,
      kinds: { ...DEFAULT_EMAIL_CAPS.kinds, ...(over.kinds ?? {}) },
      reserve: { ...DEFAULT_EMAIL_CAPS.reserve, ...(over.reserve ?? {}) },
    };
  } catch {
    return DEFAULT_EMAIL_CAPS;
  }
}

/**
 * Whether one more `kind` email fits today, given today's sends per kind
 * ({ kind: n }): null, or the cap it would pass ("cap:day", "cap:kind";
 * "cap:day" also when it would eat into another kind's unused reserve).
 * @param {typeof DEFAULT_EMAIL_CAPS} caps
 * @param {string} kind
 * @param {Record<string, number>} sent
 */
export function capReason(caps, kind, sent) {
  const total = Object.values(sent).reduce((a, b) => a + b, 0);
  const heldForOthers = Object.entries(caps.reserve ?? {}).reduce((sum, [k, n]) => (k === kind ? sum : sum + Math.max(0, Number(n) - (sent[k] ?? 0))), 0);
  if (total + heldForOthers >= caps.day) return "cap:day";
  if ((sent[kind] ?? 0) >= (caps.kinds?.[kind] ?? caps.day)) return "cap:kind";
  return null;
}

/** A keyed hash of an address: the same address always gives the same hash, and the hash reveals nothing. */
export function addressHash(address, secret = globalThis.process?.env?.AUTH_SECRET ?? "") {
  return createHmac("sha256", String(secret)).update(`email\n${String(address).trim().toLowerCase()}`).digest("base64url").slice(0, 27);
}

/** A plausible single address, at most 254 characters, with no header-breaking characters. */
export function validEmail(raw) {
  const s = String(raw ?? "").trim();
  if (s.length < 6 || s.length > 254) return null;
  if (/[\s<>()[\],;:"\\]/.test(s)) return null;
  if (!/^[^@]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(s)) return null;
  return s;
}

/**
 * The transport for this environment: the send_email binding, the test
 * outbox, or null. `env` is the Worker env (or process.env under next start).
 *
 * @param {any} env
 * @param {{ db?: any }} [options]
 * @returns {null | { name: string, send: (m: { to: string, subject: string, text: string, html?: string, kind?: string }) => Promise<void> }}
 */
export function emailTransport(env, { db } = {}) {
  const from = env?.EMAIL_FROM;
  if (env?.EMAIL_TRANSPORT === "outbox") {
    // Test runs only (lib/test-mode.mjs): anywhere else the setting is an error, never a quiet outbox.
    if (!testStandInsAllowed(env, { dev: false })) throw new Error("EMAIL_TRANSPORT=outbox is for test runs only");
    if (!db) return null;
    return {
      name: "outbox",
      async send({ to, subject, text, kind }) {
        await db.execute({
          sql: "INSERT INTO email_outbox (at, kind, to_addr, subject, text) VALUES (?, ?, ?, ?, ?)",
          args: [new Date().toISOString(), kind ?? "", to, subject, text],
        });
      },
    };
  }
  const binding = env?.SEND_EMAIL;
  if (!binding || typeof binding.send !== "function" || !from) return null;
  return {
    name: "cloudflare",
    async send({ to, subject, text, html }) {
      await binding.send({ to, from: { email: from, name: "PortfolioRank" }, subject, text, ...(html ? { html } : {}) });
    },
  };
}

/**
 * The gate. send({ kind, to, subject, text, html }) returns
 * { sent: true } or { sent: false, reason } with reason one of
 * "cap:day", "cap:kind", "cap:recipient", "no_transport", "bad_address" or
 * "error: ...". It never throws for a refused or failed send.
 *
 * @param {{ db: any, transport: null | { name: string, send: (m: { to: string, subject: string, text: string, html?: string, kind?: string }) => Promise<void> }, caps?: typeof DEFAULT_EMAIL_CAPS, secret?: string, now?: () => Date, log?: (line: string) => void }} options
 */
export function createEmailGate({ db, transport, caps = emailCaps(), secret, now = () => new Date(), log = () => {} }) {
  return {
    get enabled() {
      return Boolean(transport);
    },
    /** @param {{ kind: string, to: string, subject: string, text: string, html?: string }} m */
    async send({ kind, to, subject, text, html }) {
      const address = validEmail(to);
      if (!address) return { sent: false, reason: "bad_address" };
      if (!transport) return { sent: false, reason: "no_transport" };
      const at = now();
      const day = quotaDay(at).day;
      const toHash = addressHash(address, secret);
      // Reserve the send in one transaction, so concurrent sends can't pass a cap together.
      const tx = await db.transaction("write");
      let id;
      try {
        const rows = (
          await tx.execute({
            sql: `SELECT kind, COUNT(*) AS n, SUM(CASE WHEN to_hash = ? THEN 1 ELSE 0 END) AS to_n
                  FROM email_sends WHERE day = ? GROUP BY kind`,
            args: [toHash, day],
          })
        ).rows;
        const sent = Object.fromEntries(rows.map((r) => [String(r.kind), Number(r.n)]));
        const toN = rows.reduce((sum, r) => sum + Number(r.to_n ?? 0), 0);
        const reason = capReason(caps, kind, sent) ?? (toN >= caps.perRecipient ? "cap:recipient" : null);
        if (reason) {
          await tx.rollback();
          log(`email gate: ${kind} refused (${reason})`);
          return { sent: false, reason };
        }
        id = Number(
          (
            await tx.execute({
              sql: "INSERT INTO email_sends (at, day, kind, to_hash, status) VALUES (?, ?, ?, ?, 'sending') RETURNING id",
              args: [at.toISOString(), day, kind, toHash],
            })
          ).rows[0].id
        );
        await tx.commit();
      } finally {
        tx.close();
      }
      try {
        await transport.send({ to: address, subject, text, html, kind });
        await db.execute({ sql: "UPDATE email_sends SET status = 'sent' WHERE id = ?", args: [id] });
        return { sent: true };
      } catch (e) {
        // Never the address or the body: the provider's error, cut short.
        const reason = `error: ${String(e?.message ?? e).replace(/[^\s@]+@[^\s@]+/g, "[email]").slice(0, 120)}`;
        await db.execute({ sql: "UPDATE email_sends SET status = 'failed', reason = ? WHERE id = ?", args: [reason, id] });
        log(`email gate: ${kind} failed (${reason})`);
        return { sent: false, reason };
      }
    },
  };
}

/** Alert key prefix for the email caps (pipeline/alerts.mjs reconcileAlerts scope). */
export const EMAIL_CAP_ALERT = "email-cap:";
export const isEmailCapAlert = (key) => String(key).startsWith(EMAIL_CAP_ALERT);
/** The share of a cap that alerts the owner. */
export const EMAIL_ALERT_AT = 0.8;

/**
 * Owner alerts for today's email caps: one for each kind, and one for the
 * day's total, that has used at least EMAIL_ALERT_AT of its cap.
 * @param {any} db
 * @param {{ now?: Date, caps?: typeof DEFAULT_EMAIL_CAPS }} [options]
 */
export async function emailCapConditions(db, { now = new Date(), caps = emailCaps() } = {}) {
  const day = quotaDay(now).day;
  let rows = [];
  try {
    rows = (await db.execute({ sql: "SELECT kind, COUNT(*) AS n FROM email_sends WHERE day = ? GROUP BY kind", args: [day] })).rows;
  } catch (e) {
    if (/no such table/i.test(String(e?.message ?? e))) return [];
    throw e;
  }
  const sent = Object.fromEntries(rows.map((r) => [String(r.kind), Number(r.n)]));
  const total = Object.values(sent).reduce((a, b) => a + b, 0);
  const out = [];
  const check = (name, n, cap) => {
    if (cap > 0 && n >= Math.ceil(cap * EMAIL_ALERT_AT)) {
      out.push({
        key: `${EMAIL_CAP_ALERT}${name}`,
        kind: "problem",
        title: `Email: ${n} of ${cap} ${name === "day" ? "emails" : `"${name}" emails`} used today`,
        detail: `On ${day}, ${n} of the ${cap} allowed ${name === "day" ? "emails of every kind" : `"${name}" emails`} were sent or tried (${Math.round((n / cap) * 100)}%). Past the cap the email gate refuses more until midnight Pacific. If this isn't real use, someone may be draining the pool: check email_sends and the request logs.`,
      });
    }
  };
  check("day", total, caps.day);
  for (const [kind, cap] of Object.entries(caps.kinds ?? {})) check(kind, sent[kind] ?? 0, Number(cap));
  return out;
}

/** Today's sends by kind and status, for the admin view. */
export async function emailToday(db, { now = new Date() } = {}) {
  const day = quotaDay(now).day;
  const rows = (await db.execute({ sql: "SELECT kind, status, COUNT(*) AS n FROM email_sends WHERE day = ? GROUP BY kind, status", args: [day] })).rows;
  return { day, rows: rows.map((r) => ({ kind: String(r.kind), status: String(r.status), n: Number(r.n) })) };
}
