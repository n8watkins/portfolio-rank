// "Get it by email" (owner decisions 2026-11-10): a visitor leaves an
// address and gets a one-time link to the report when it is ready, also
// when it waited in a queue (Gemini busy or out of quota, or past the day's
// share). Every email goes through the shared gate (lib/email/gate.mjs,
// kind "grade-report") with its hard caps.
//
// The address waits in grade_emails only until its email is sent (or given
// up on): then it is erased, and only its keyed hash stays, so the same
// address can't be added twice to one report.
import { addressHash, validEmail } from "../email/gate.mjs";
import { createLinkToken } from "./links.mjs";
import { isTier, tierLabel } from "../tiers.mjs";

/** Addresses one report can be sent to. */
export const EMAILS_PER_JOB = 2;
/** A waiting address the gate keeps refusing is given up after this long. */
export const GIVE_UP_MS = 3 * 86400000;

const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return String(url);
  }
};

/** The report email (plain text and simple HTML). */
export function reportEmail({ url, link, status, tier: letter = null }) {
  // A tier by ELO reads with a real minus sign ("A−"); Gemini's letters are unchanged.
  const tier = typeof letter === "string" ? tierLabel(letter) : letter;
  const domain = domainOf(url);
  if (status === "failed") {
    return {
      subject: `We couldn't grade ${domain}`,
      text: [
        `We couldn't finish the PortfolioRank grade for ${domain}.`,
        "The page may have been down, blocked our browser, or the AI grade failed.",
        "",
        `What we have: ${link}`,
        "",
        "This link works once and expires in 7 days. Didn't ask for this? Ignore it; nothing else happens.",
      ].join("\n"),
    };
  }
  const text = [
    `Your PortfolioRank grade for ${domain} is ready${tier ? `: tier ${tier}` : ""}.`,
    "The report shows the measured facts, the AI's judgment, where you'd rank and the three things to fix first.",
    "",
    `Open my report: ${link}`,
    "",
    "This link works once and expires in 7 days. Didn't ask for this? Ignore it; nothing else happens.",
  ].join("\n");
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html><body style="margin:0;background:#f6f6f7;font-family:Inter,Segoe UI,Arial,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:480px;background:#ffffff;border:1px solid #e4e4e7;border-radius:14px" cellpadding="0" cellspacing="0"><tr><td style="padding:28px 24px">
<p style="margin:0 0 6px;font-size:20px;font-weight:700">Your grade for ${esc(domain)} is ready${tier ? ` (tier ${esc(tier)})` : ""}</p>
<p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#52525b">The tier, where you'd rank, and the three things to fix first.</p>
<a href="${esc(link)}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:11px 18px;border-radius:10px">Open my report</a>
<p style="margin:20px 0 0;font-size:13px;line-height:1.5;color:#71717a">This link works once and expires in 7 days. Didn't ask for this? Ignore it; nothing else happens.</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject: `Your PortfolioRank report for ${domain} is ready`, text, html };
}

/**
 * Records an address for a job's report. Returns { ok: true, duplicate }
 * or { ok: false, error: "bad_email" | "too_many" }.
 *
 * @param {any} db
 * @param {{ jobId: string, email: unknown, secret: string, now?: number }} options
 * @returns {Promise<{ ok: true, duplicate: boolean, error?: undefined } | { ok: false, error: "bad_email" | "too_many" }>}
 */
export async function requestEmail(db, { jobId, email, secret, now = Date.now() }) {
  const address = validEmail(email);
  if (!address) return { ok: false, error: "bad_email" };
  const hash = addressHash(address, secret);
  const rows = (await db.execute({ sql: "SELECT email_hash FROM grade_emails WHERE job_id = ?", args: [jobId] })).rows;
  if (rows.some((r) => r.email_hash === hash)) return { ok: true, duplicate: true };
  if (rows.length >= EMAILS_PER_JOB) return { ok: false, error: "too_many" };
  await db.execute({
    sql: `INSERT INTO grade_emails (job_id, email, email_hash, status, created_at) VALUES (?, ?, ?, 'waiting', ?)
          ON CONFLICT(job_id, email_hash) DO NOTHING`,
    args: [jobId, address, hash, new Date(now).toISOString()],
  });
  return { ok: true, duplicate: false };
}

/**
 * Sends the waiting emails of finished jobs (done or failed), oldest first.
 * `base` is the site's address for the link. Returns { sent, refused, gaveUp }.
 *
 * @param {any} db
 * @param {{ gate: { send: (m: { kind: string, to: string, subject: string, text: string, html?: string }) => Promise<{ sent: boolean, reason?: string }> }, secret: string, base: string, now?: number, limit?: number, jobId?: string | null, eloTiers?: boolean, log?: (line: string) => void }} options
 */
export async function sendDueEmails(db, { gate, secret, base, now = Date.now(), limit = 20, jobId = null, eloTiers = false, log = () => {} }) {
  const out = { sent: 0, refused: 0, gaveUp: 0 };
  const rows = (
    await db.execute({
      sql: `SELECT e.id, e.job_id, e.email, e.created_at, j.url, j.status, j.result, j.report FROM grade_emails e JOIN grade_jobs j ON j.id = e.job_id
            WHERE e.status = 'waiting' AND j.status IN ('done', 'failed') ${jobId ? "AND e.job_id = ?" : ""}
            ORDER BY e.created_at, e.id LIMIT ?`,
      args: jobId ? [jobId, limit] : [limit],
    })
  ).rows;
  for (const r of rows) {
    const { token } = await createLinkToken(db, { jobId: String(r.job_id), secret, now });
    const link = `${base.replace(/\/+$/, "")}/api/grade/link?t=${encodeURIComponent(token)}`;
    let tier = null;
    try {
      if (eloTiers) {
        // Tiers by ELO (RANKING_V2): the tier by rank (lib/tiers.mjs) as the report shows it, from day one
        // (#210), never Gemini's own letter.
        const rank = JSON.parse(String(r.report ?? "null"))?.rank;
        tier = isTier(rank?.tier) ? tierLabel(rank.tier) : null;
      } else {
        // Until then, Gemini's letter, as production sends it.
        tier = JSON.parse(String(r.result ?? "null"))?.tier ?? null;
      }
    } catch {
      /* no grade */
    }
    const mail = reportEmail({ url: String(r.url), link, status: String(r.status), tier });
    const res = await gate.send({ kind: "grade-report", to: String(r.email), ...mail });
    const at = new Date(now).toISOString();
    if (res.sent) {
      await db.execute({ sql: "UPDATE grade_emails SET status = 'sent', email = NULL, sent_at = ?, reason = NULL WHERE id = ?", args: [at, r.id] });
      out.sent++;
    } else if (res.reason === "bad_address" || now - Date.parse(String(r.created_at)) > GIVE_UP_MS) {
      await db.execute({ sql: "UPDATE grade_emails SET status = 'dropped', email = NULL, reason = ? WHERE id = ?", args: [res.reason, r.id] });
      out.gaveUp++;
    } else {
      // A cap or the provider: tried again on the next tick (the link made now simply expires unused).
      await db.execute({ sql: "UPDATE grade_emails SET reason = ? WHERE id = ?", args: [res.reason, r.id] });
      out.refused++;
      log(`grade report email waits: ${res.reason}`);
      if (/^cap:(day|kind)$/.test(res.reason) || res.reason === "no_transport") break;
    }
  }
  return out;
}

/** Whether a job has addresses waiting or sent (never the addresses). */
export async function emailState(db, jobId) {
  const rows = (await db.execute({ sql: "SELECT status FROM grade_emails WHERE job_id = ?", args: [jobId] })).rows.map((r) => String(r.status));
  return { requested: rows.length > 0, sent: rows.includes("sent"), waiting: rows.includes("waiting") };
}

/** Erases addresses still waiting on jobs that ended long ago, or that never ended (housekeeping). */
export async function pruneEmails(db, { now = Date.now(), days = 30 } = {}) {
  return (
    await db.execute({
      sql: "UPDATE grade_emails SET email = NULL, status = 'dropped', reason = 'expired' WHERE status = 'waiting' AND created_at < ?",
      args: [new Date(now - days * 86400000).toISOString()],
    })
  ).rowsAffected;
}
