// Daily caps on "grade my portfolio", reserved atomically in the database
// (owner decisions 2026-11-10; AUTOMATION.md "Grade my portfolio").
//
// Every request reserves one unit of three counters in one write
// transaction: the visitor's (signed-in account or signed browser cookie),
// the network's (the IPv4 address or the IPv6 /64, as a keyed hash) and the
// site-wide one. All three are taken, or none: a request over any cap
// changes nothing. Days are the Gemini quota day (midnight to midnight
// Pacific), so the caps and the free quota reset together.
//
// A visitor or a network over its cap is refused. The site-wide cap is the
// day's share of captures and grades: past it a request is not refused but
// waits for tomorrow's share and is emailed when ready (DECISIONS.md, "Queue
// and email past the daily cap"); the waiting line has its own cap.
import { quotaDay } from "../../pipeline/quota-day.mjs";

export const DEFAULT_CAPS = {
  // Grade requests a day per visitor (account or browser).
  visitor: 3,
  // Per network (one IPv4 address or one IPv6 /64).
  network: 6,
  // Per IPv6 /48: one cheap server gets a /56 or a /48, which is 256 or
  // 65,536 /64s, so the /64 cap alone doesn't hold a script back.
  network48: 12,
  // Site-wide captures and grades a day; past it requests wait for tomorrow.
  site: 100,
  // Of the site-wide share, this many are kept for signed-in GitHub
  // accounts older than TRUSTED_ACCOUNT_DAYS: anyone else is past the day's
  // share at site - trusted, so a bot can't take the whole day.
  trusted: 30,
  // At most this many requests wait for a later day at once,
  waiting: 50,
  // and at most this many from one network (IPv4 address or IPv6 /64).
  waitingPerNetwork: 2,
};

/** A signed-in GitHub account at least this old may use the day's trusted share. */
export const TRUSTED_ACCOUNT_DAYS = 30;

/**
 * True for a signed-in GitHub account (raterId gh:<id>) created at least TRUSTED_ACCOUNT_DAYS ago.
 * @param {{ raterId?: string | null, accountCreatedAt?: string | null, now?: number }} [who]
 */
export function trustedAccount({ raterId, accountCreatedAt, now = Date.now() } = {}) {
  if (!String(raterId ?? "").startsWith("gh:")) return false;
  const created = Date.parse(String(accountCreatedAt ?? ""));
  return Number.isFinite(created) && now - created >= TRUSTED_ACCOUNT_DAYS * 86400000;
}

/** The site-wide count a request may reach: the whole share for a trusted account, the rest for anyone else. */
export const siteCapFor = (caps, trusted) => (trusted ? caps.site : Math.max(0, caps.site - (caps.trusted ?? 0)));

/** DEFAULT_CAPS with a GRADER_CAPS JSON override (a Worker variable). */
/** @param {string | undefined} [raw] */
export function graderCaps(raw = globalThis.process?.env?.GRADER_CAPS) {
  try {
    const over = raw ? JSON.parse(raw) : {};
    const out = { ...DEFAULT_CAPS };
    for (const k of Object.keys(DEFAULT_CAPS)) if (Number.isFinite(Number(over[k])) && over[k] !== null && over[k] !== "") out[k] = Math.max(0, Math.floor(Number(over[k])));
    return out;
  } catch {
    return { ...DEFAULT_CAPS };
  }
}

const key = (day, scope, id) => `${day}|${scope}|${id}`;

/**
 * Reserves one request against the visitor's, the network's, the IPv6
 * /48's and (unless `site: false`) the site-wide cap of `day`; the site-wide
 * cap is siteCapFor(caps, trusted). Returns
 * { ok: true, day, counts } or { ok: false, scope: "visitor" | "network" | "network48" | "site", day }.
 * Nothing is counted when it is refused.
 *
 * @param {any} db
 * @param {{ visitor: string, network?: string, network48?: string, site?: boolean, trusted?: boolean, now?: Date, caps?: typeof DEFAULT_CAPS, day?: string }} options
 * @returns {Promise<{ ok: true, day: string, counts: Record<string, number>, scope?: undefined } | { ok: false, scope: "visitor" | "network" | "network48" | "site", day: string }>}
 */
export async function reserveCaps(db, options) {
  // Concurrent write transactions can meet a held lock; the reservation is all-or-nothing, so try again.
  for (let attempt = 0; ; attempt++) {
    try {
      return await reserveOnce(db, options);
    } catch (e) {
      if (attempt >= 4 || !/SQLITE_BUSY|database is locked/i.test(String(e?.message ?? e))) throw e;
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1) + Math.random() * 25));
    }
  }
}

/** @param {any} db @param {any} options */
async function reserveOnce(db, { visitor, network, network48, site = true, trusted = false, now = new Date(), caps = DEFAULT_CAPS, day = quotaDay(now).day }) {
  const wanted = [
    ["visitor", visitor, caps.visitor],
    ["network", network, caps.network],
    ["network48", network48, caps.network48 ?? Infinity],
    ...(site ? [["site", "all", siteCapFor(caps, trusted)]] : []),
  ].filter(([, id]) => id);
  const tx = await db.transaction("write");
  try {
    const counts = {};
    for (const [scope, id, cap] of wanted) {
      const r = await tx.execute({
        sql: `INSERT INTO grade_caps (k, day, n) VALUES (?, ?, 1)
              ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n`,
        args: [key(day, scope, id), day],
      });
      const n = Number(r.rows[0]?.n ?? 1);
      if (n > cap) {
        await tx.rollback();
        return { ok: false, scope, day };
      }
      counts[scope] = n;
    }
    await tx.commit();
    return { ok: true, day, counts };
  } finally {
    tx.close();
  }
}

/**
 * Takes one unit of the site-wide cap of `day` for a request that waited;
 * false when the day is full. Waiting requests use the open share only
 * (siteCapFor(caps, false)), so a line a script filled can't take the
 * trusted accounts' part of the next day.
 */
export async function reserveSite(db, { day, caps = DEFAULT_CAPS }) {
  const cap = siteCapFor(caps, false);
  const r = await db.execute({
    sql: `INSERT INTO grade_caps (k, day, n) VALUES (?, ?, 1)
          ON CONFLICT(k) DO UPDATE SET n = n + 1 WHERE grade_caps.n < ? RETURNING n`,
    args: [key(day, "site", "all"), day, cap],
  });
  return r.rows.length > 0 && Number(r.rows[0].n) <= cap;
}

/** What the site-wide cap has left on `day`. */
export async function siteLeft(db, { day, caps = DEFAULT_CAPS }) {
  const r = await db.execute({ sql: "SELECT n FROM grade_caps WHERE k = ?", args: [key(day, "site", "all")] });
  return Math.max(0, caps.site - Number(r.rows[0]?.n ?? 0));
}

/** Deletes counters of days before `day` (housekeeping). */
export async function pruneCaps(db, { day }) {
  const r = await db.execute({ sql: "DELETE FROM grade_caps WHERE day < ?", args: [day] });
  return r.rowsAffected;
}

/**
 * The network a client is on, for the per-network cap: the IPv4 address
 * itself, or the /64 prefix of an IPv6 address (one home or phone usually
 * gets a whole /64). "" when unknown.
 */
export function networkOf(ip) {
  const a = String(ip ?? "").trim().toLowerCase();
  if (!a) return "";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(a)) return a;
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  if (!a.includes(":")) return "";
  // Expand "::" to find the first four groups.
  const [head, tail = ""] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = a.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = a.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** The IPv6 /48 a client is on (from networkOf's /64), for the per-/48 cap; "" for IPv4 or unknown. */
export function network48Of(ip) {
  const n = networkOf(ip);
  if (!n.endsWith("::/64")) return "";
  return `${n.split(":").slice(0, 3).join(":")}::/48`;
}
