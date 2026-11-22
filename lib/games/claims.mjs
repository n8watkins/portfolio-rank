// Claim your portfolio (owner decision 2026-11-10): a GitHub account proves
// it owns a listed portfolio, then may remove it, hide its grade or ask for
// a re-grade. Every step is written to claim_log, the audit log.
//
// Proof, tried in this order:
//   github_pages the portfolio is <login>.github.io (or a path under it):
//                GitHub itself says the site belongs to that account
//   github_link  the portfolio's home page links to github.com/<login>, the
//                profile itself (not a repository under it; not accepted
//                for a site built from a known template, whose footer often
//                links the template's author, nor on another account's
//                github.io site)
//   meta         the home page has <meta name="portfoliorank-verify"
//                content="<the claim's token>">
//   manual       a request the site owner reviews by hand
// With "Add your portfolio" on (TOOLS_ENABLED), claims go through
// lib/ownership/verify.mjs instead: a verification file or the
// portfoliorank-verification meta tag, checked when the owner presses Verify,
// or github_pages at once; the github_link proof isn't offered there.
// Never the GitHub profile's Website field: anyone can type any domain
// there, so it proves nothing about who controls the site.
// An account verifies at most MAX_VERIFIED portfolios on its own; more go
// to manual review.
//
// A page links many GitHub profiles that aren't its owner's: collaborators,
// a designer's credit, a template's author. So a link proves enough to ask
// for a re-grade (the grade service applies its own cooldown), and nothing
// that changes or reveals what others see: hiding or showing the grade,
// removing the site, cancelling a held removal and reading a hidden grade
// ask for proof only someone who can deploy to the site can give
// (controlProof): the verification file, the meta tag, github_pages, or a
// claim the site owner reviewed.
// A fork or copy of a portfolio lives at another address (the forker's own
// github.io or domain), and every proof is checked on the listed address's
// own page, so a copy can't claim or remove the original. A removal is held
// for REMOVAL_HOLD_MS: the owner of PortfolioRank is alerted
// (removalConditions), any account with control proof can cancel it (both
// can deploy to the site; the cancel is logged with who cancelled and
// whether they asked; it sends no email by itself), and the admin can undo it, before
// or after it takes effect (undoRemoval). applyDueRemovals, hourly
// (worker/owner-removals.ts), makes the held ones take effect, and
// purgeRemovedProfiles takes each one out of the edge cache, retrying on
// later hours until the purge succeeds.
//
// Plain JavaScript: the checks are pure functions over fetched text, and the
// store takes a libSQL client, so the tests need no server or network.

import { markForced } from "../freshness.mjs";
import { clearPoolStatement } from "./pool.mjs";
import { sameSiteRows } from "../ownership/same-site.mjs";

export const META_NAME = "portfoliorank-verify";
export const MAX_VERIFIED = 3;
export const NOTE_MAX = 500;
export const ACTIONS = ["remove", "cancel_remove", "hide_grade", "show_grade", "regrade"];
/** ownerAction's refusals that mean "not with this account's proof" (403 in /api/owner/actions). */
export const PROOF_ERRORS = ["not_owner", "remove_needs_meta", "cancel_needs_meta", "hide_needs_meta"];
/** How long a removal waits before it takes effect. */
export const REMOVAL_HOLD_MS = 24 * 60 * 60 * 1000;

const iso = (d) => new Date(d).toISOString();

/** A URL's host without "www.", lower case; "" when it isn't a URL. */
export function hostOf(url) {
  try {
    const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(String(url)) ? String(url) : `https://${url}`;
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** GitHub logins: letters, digits and single hyphens, 1 to 39 characters. */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * True when the HTML links to the GitHub profile of `login` itself
 * (github.com/<login>, a trailing slash, query or fragment allowed). A link
 * to one of its repositories doesn't count: portfolios link collaborators'
 * and libraries' repositories, which says nothing about who owns the site.
 */
export function linksToGithub(html, login) {
  if (!GITHUB_LOGIN.test(String(login ?? ""))) return false;
  const re = new RegExp(`href\\s*=\\s*["']?(?:https?:)?//(?:www\\.)?github\\.com/${escapeRe(login)}/?(?=["'?#\\s>]|$)`, "i");
  return re.test(String(html ?? ""));
}

/** The content of every <meta name="portfoliorank-verify"> tag, in either attribute order. */
export function metaTokens(html) {
  const out = [];
  for (const m of String(html ?? "").matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const name = tag.match(/\bname\s*=\s*["']?([^"'\s>]+)/i)?.[1];
    if (name?.toLowerCase() !== META_NAME) continue;
    const content = tag.match(/\bcontent\s*=\s*["']?([^"'\s>]+)/i)?.[1];
    if (content) out.push(content);
  }
  return out;
}

/**
 * Which automatic proof holds, or null:
 *   page      { html, finalUrl } of the portfolio's home page as fetched
 *             (null when it couldn't be fetched)
 *   login     the signed-in account's current GitHub login
 *   template  the template the site was built from (portfolios.facts), or null
 * @param {{ url: string, page: { html: string, finalUrl: string } | null, login: string, template?: string | null }} args
 */
export function autoProof({ url, page, login, template = null }) {
  const host = hostOf(url);
  // A github.io site belongs to the account in its name: that account is
  // proof by itself, and a link on it to anyone else proves nothing.
  const pages = pagesAccount(url);
  if (pages) return GITHUB_LOGIN.test(String(login ?? "")) && pages === String(login).toLowerCase() ? "github_pages" : null;
  // The page must still be the portfolio: a redirect elsewhere proves nothing.
  if (page && !template && hostOf(page.finalUrl) === host && linksToGithub(page.html, login)) return "github_link";
  return null;
}

/** The GitHub account a *.github.io address belongs to (lower case), or null. */
export function pagesAccount(url) {
  const m = hostOf(url).match(/^([a-z0-9](?:[a-z0-9-]{0,38}))\.github\.io$/);
  return m ? m[1] : null;
}

/** True when the home page carries the claim's meta tag. */
export function metaProof({ url, page, token }) {
  return Boolean(page && hostOf(page.finalUrl) === hostOf(url) && metaTokens(page.html).includes(token));
}

export async function logClaim(db, { url, actor, action, detail = null, now = new Date() }) {
  await db.execute({
    sql: "INSERT INTO claim_log (at, url, actor, action, detail) VALUES (?, ?, ?, ?, ?)",
    args: [iso(now), url, actor, action, detail == null ? null : JSON.stringify(detail)],
  });
}

/**
 * Proofs no longer accepted. A claim verified by one of them counts as
 * pending again (its owner proves it once more with a link or the meta tag),
 * and gives no owner rights.
 */
export const RETIRED_PROOFS = ["github_blog"];
const RETIRED_SQL = `(method IS NULL OR method NOT IN (${RETIRED_PROOFS.map((m) => `'${m}'`).join(", ")}))`;

const statusOf = (r) => (String(r.status) === "verified" && RETIRED_PROOFS.includes(String(r.method)) ? "pending" : String(r.status));

const claimOf = (r) =>
  r && {
    id: Number(r.id),
    url: String(r.url),
    owner: String(r.owner),
    login: String(r.login),
    status: statusOf(r),
    method: r.method == null ? null : String(r.method),
    token: String(r.token),
    note: r.note == null ? null : String(r.note),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };

const COLS = "id, url, owner, login, status, method, token, note, created_at, updated_at";

export async function getClaim(db, { url, owner }) {
  return claimOf((await db.execute({ sql: `SELECT ${COLS} FROM claims WHERE url = ? AND owner = ?`, args: [url, owner] })).rows[0]);
}

export async function claimById(db, id) {
  return claimOf((await db.execute({ sql: `SELECT ${COLS} FROM claims WHERE id = ?`, args: [id] })).rows[0]);
}

export async function listClaims(db, owner) {
  return (await db.execute({ sql: `SELECT ${COLS} FROM claims WHERE owner = ? ORDER BY created_at DESC LIMIT 50`, args: [owner] })).rows.map(claimOf);
}

/** Claims waiting for the site owner's review, oldest first. */
export async function reviewQueue(db, { limit = 100 } = {}) {
  return (await db.execute({ sql: `SELECT ${COLS} FROM claims WHERE status = 'review' ORDER BY updated_at LIMIT ?`, args: [limit] })).rows.map(claimOf);
}

/** The account's claim on `url`, created (pending, with a fresh token) when it has none. */
export async function openClaim(db, { url, owner, login, token, now = new Date() }) {
  const res = await db.execute({
    sql: `INSERT OR IGNORE INTO claims (url, owner, login, status, method, token, created_at, updated_at)
          VALUES (?, ?, ?, 'pending', NULL, ?, ?, ?)`,
    args: [url, owner, login, token, iso(now), iso(now)],
  });
  if (res.rowsAffected) await logClaim(db, { url, actor: owner, action: "claim_started", detail: { login }, now });
  return getClaim(db, { url, owner });
}

export async function verifiedCount(db, owner) {
  return Number((await db.execute({ sql: `SELECT COUNT(*) AS n FROM claims WHERE owner = ? AND status = 'verified' AND ${RETIRED_SQL}`, args: [owner] })).rows[0].n);
}

/** Moves a claim to a new status and logs it. Returns the claim. */
export async function setClaimStatus(db, { claim, status, method = claim.method, note, actor, now = new Date() }) {
  await db.batch(
    [
      {
        sql: "UPDATE claims SET status = ?, method = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?",
        args: [status, method, note ?? null, iso(now), claim.id],
      },
      {
        sql: "INSERT INTO claim_log (at, url, actor, action, detail) VALUES (?, ?, ?, ?, ?)",
        args: [iso(now), claim.url, actor, `claim_${status}`, JSON.stringify({ claim: claim.id, method, ...(note ? { note } : {}) })],
      },
    ],
    "write"
  );
  return claimById(db, claim.id);
}

/**
 * True when `owner` holds a verified claim on `url`, of any proof (proofLevel
 * not "none"). A link-only claim counts: for anything that changes or reveals
 * what others see, ask controlProof.
 */
export async function isVerifiedOwner(db, { url, owner }) {
  return (await proofLevel(db, { url, owner })) !== "none";
}

/**
 * What owners chose for a site: { hideGrade, removedAt, removeAfter }.
 * removeAfter is when a held removal takes effect (null when none waits);
 * removedAt is set once it has.
 * A choice made under another spelling of the same site counts
 * (lib/ownership/same-site.mjs ownerSiteKey: scheme, host case, "www." and
 * trailing slashes; never a different query or path).
 */
export async function ownerState(db, url) {
  return (await ownerRow(db, url)).state;
}

const earliest = (values) => values.filter(Boolean).sort()[0] ?? null;

/**
 * ownerState plus the account that asked for a held removal (removedBy) and
 * the held rows themselves ({ url, removeAfter }, for a cancel), in one read.
 */
async function ownerRow(db, url) {
  const rows = await sameSiteRows(db, url);
  const removedAt = earliest(rows.map((r) => r.removedAt));
  const heldRows = removedAt ? [] : rows.filter((r) => r.removeAfter && !r.removedAt);
  const removeAfter = earliest(heldRows.map((r) => r.removeAfter));
  return {
    state: { hideGrade: rows.some((r) => r.hideGrade), removedAt, removeAfter },
    removedBy: heldRows.find((r) => r.removeAfter === removeAfter)?.removedBy ?? null,
    held: heldRows.map((r) => ({ url: r.url, removeAfter: r.removeAfter })),
    urls: rows.map((r) => r.url),
  };
}

/** Proofs only the site's owner can give (see the top of this file). */
// "file": the verification file at the site root (lib/ownership/verify.mjs), with "Add your portfolio" on.
export const CONTROL_PROOFS = ["meta", "github_pages", "file"];

/**
 * What `owner`'s claim on `url` proves, from one read of the claim:
 *   "none"     no verified claim (or one verified by a retired proof)
 *   "link"     verified, but not by proof of control: in practice a link
 *              from the page to the GitHub profile, enough only to ask for a
 *              re-grade
 *   "control"  proof only someone who can deploy to the site can give: the
 *              verification file, the meta tag, github_pages, or a claim the
 *              site owner reviewed (an "admin:" actor in the audit log)
 */
export async function proofLevel(db, { url, owner }) {
  const r = await db.execute({
    sql: `SELECT c.method,
            EXISTS (SELECT 1 FROM claim_log l WHERE l.url = c.url AND l.action = 'claim_verified' AND l.actor LIKE 'admin:%'
                    AND (CASE WHEN json_valid(l.detail) THEN json_extract(l.detail, '$.claim') END) = c.id) AS reviewed
          FROM claims c WHERE c.url = ? AND c.owner = ? AND c.status = 'verified' AND ${RETIRED_SQL}`,
    args: [url, owner],
  });
  const row = r.rows[0];
  if (!row) return "none";
  return CONTROL_PROOFS.includes(String(row.method)) || Number(row.reviewed) === 1 ? "control" : "link";
}

/**
 * True when `owner`'s verified claim on `url` is strong enough to change or
 * reveal what others see (proofLevel "control"). A link from the page to the
 * GitHub profile is not enough on its own.
 */
export async function controlProof(db, { url, owner }) {
  return (await proofLevel(db, { url, owner })) === "control";
}

/** The proof removal asks for (the same as controlProof). */
export const removalProof = controlProof;

/**
 * A verified owner's action on their portfolio, logged:
 *   remove         (needs removalProof) held for REMOVAL_HOLD_MS, then
 *                  hidden from the site (applyDueRemovals); the weekly
 *                  health workflow then moves it to data/excluded.json
 *                  ("owner request") through its bot pull request
 *                  (pipeline/owner-removals.mjs)
 *   cancel_remove  (needs controlProof, like remove) withdraws a removal
 *                  that hasn't taken effect yet. Any account with control
 *                  proof may cancel, not only the one that asked: both can
 *                  deploy to the site. The log row names the canceller and
 *                  says whether it is the account that asked (byRequester:
 *                  no account id in the free-form detail). A cancel sends no
 *                  email by itself (the site stays listed); a removal asked
 *                  for again after one says so in its alert (removalConditions).
 *   hide_grade     the AI grade is no longer shown; show_grade undoes it
 *                  (both need controlProof)
 *   regrade        a request for the grade service, which applies its own
 *                  cooldown; one open request per site
 * Returns { ok: true, state, regrade? } or { ok: false, error }; error
 * "remove_needs_meta", "cancel_needs_meta" or "hide_needs_meta" when the
 * claim's proof isn't enough for that action.
 */
export async function ownerAction(db, { url, owner, action, now = new Date() }) {
  if (!ACTIONS.includes(action)) return { ok: false, error: "bad_action" };
  // One read of the claim decides every action's proof.
  const proof = await proofLevel(db, { url, owner });
  if (proof === "none") return { ok: false, error: "not_owner" };
  const control = proof === "control";
  const at = iso(now);
  if (action === "remove" || action === "cancel_remove") {
    if (!control) return { ok: false, error: action === "remove" ? "remove_needs_meta" : "cancel_needs_meta" };
    const { state, removedBy, held } = await ownerRow(db, url);
    // Already removed (under any spelling), or nothing to cancel: nothing changes (and nothing is logged).
    if (state.removedAt || (action === "remove" && state.removeAfter) || (action === "cancel_remove" && !state.removeAfter)) return { ok: true, state };
    const after = action === "remove" ? iso(now.getTime() + REMOVAL_HOLD_MS) : null;
    const detail = after ? { removeAfter: after } : { removeAfter: state.removeAfter, byRequester: removedBy == null ? null : removedBy === owner };
    await db.batch(
      [
        // A cancel withdraws the held removals it saw, under every spelling of the site: one that
        // took effect meanwhile stays (applyDueRemovals).
        after
          ? {
              sql: `INSERT INTO portfolio_owner (url, hide_grade, remove_after, removed_by, updated_at) VALUES (?, 0, ?, ?, ?)
                    ON CONFLICT(url) DO UPDATE SET remove_after = excluded.remove_after, removed_by = excluded.removed_by, updated_at = excluded.updated_at`,
              args: [url, after, owner, at],
            }
          : {
              sql: `UPDATE portfolio_owner SET remove_after = NULL, removed_by = NULL, updated_at = ?
                    WHERE removed_at IS NULL AND (${held.map(() => "(url = ? AND remove_after = ?)").join(" OR ")})`,
              args: [at, ...held.flatMap((h) => [h.url, h.removeAfter])],
            },
        {
          sql: "INSERT INTO claim_log (at, url, actor, action, detail) SELECT ?, ?, ?, ?, ? WHERE changes() > 0",
          args: [at, url, owner, after ? "remove_requested" : "remove_cancelled", JSON.stringify(detail)],
        },
      ],
      "write"
    );
    return { ok: true, state: await ownerState(db, url) };
  }
  if ((action === "hide_grade" || action === "show_grade") && !control) return { ok: false, error: "hide_needs_meta" };
  if (action === "regrade") {
    const res = await db.execute({
      sql: `INSERT INTO regrade_requests (url, requested_by, requested_at, status)
            SELECT ?, ?, ?, 'pending' WHERE NOT EXISTS (SELECT 1 FROM regrade_requests WHERE url = ? AND status = 'pending')`,
      args: [url, owner, at, url],
    });
    const queued = res.rowsAffected > 0;
    // A re-grade measures everything again: Lighthouse and polish on the next
    // view, the screenshots and link checks tonight (lib/freshness.mjs).
    if (queued) await markForced(db, url, { now: new Date(now).getTime() });
    await logClaim(db, { url, actor: owner, action: queued ? "regrade_requested" : "regrade_already_pending", now });
    return { ok: true, state: await ownerState(db, url), regrade: { queued, pending: true } };
  }
  const hide = action === "hide_grade" ? 1 : 0;
  // Showing the grade again shows it under every spelling: a hide asked for under another one is lifted too.
  const others = hide ? [] : (await ownerRow(db, url)).urls.filter((u) => u !== url);
  await db.batch(
    [
      {
        sql: `INSERT INTO portfolio_owner (url, hide_grade, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(url) DO UPDATE SET hide_grade = excluded.hide_grade, updated_at = excluded.updated_at`,
        args: [url, hide, at],
      },
      ...(others.length ? [{ sql: `UPDATE portfolio_owner SET hide_grade = 0, updated_at = ? WHERE hide_grade = 1 AND url IN (${others.map(() => "?").join(", ")})`, args: [at, ...others] }] : []),
      { sql: "INSERT INTO claim_log (at, url, actor, action, detail) VALUES (?, ?, ?, ?, NULL)", args: [at, url, owner, action] },
    ],
    "write"
  );
  return { ok: true, state: await ownerState(db, url) };
}

/** Removals still held: [{ url, removeAfter, requestedBy, login }], soonest first. */
export async function pendingRemovals(db) {
  const r = await db.execute(
    `SELECT o.url, o.remove_after, o.removed_by, (SELECT c.login FROM claims c WHERE c.url = o.url AND c.owner = o.removed_by) AS login
     FROM portfolio_owner o WHERE o.remove_after IS NOT NULL AND o.removed_at IS NULL ORDER BY o.remove_after`
  );
  return r.rows.map((row) => ({
    url: String(row.url),
    removeAfter: String(row.remove_after),
    requestedBy: row.removed_by == null ? null : String(row.removed_by),
    login: row.login == null ? null : String(row.login),
  }));
}

/**
 * Makes every held removal whose time has come take effect, logged, and
 * drops the cached quiz pool in the same transaction, so a removed site never
 * waits for the pool's next rebuild. Returns the urls.
 */
export async function applyDueRemovals(db, { now = new Date() } = {}) {
  const at = iso(now);
  const due = (await db.execute({ sql: "SELECT url, remove_after FROM portfolio_owner WHERE remove_after IS NOT NULL AND removed_at IS NULL AND remove_after <= ?", args: [at] })).rows;
  const urls = [];
  for (const row of due) {
    const res = await db.batch(
      [
        {
          sql: "UPDATE portfolio_owner SET removed_at = remove_after, remove_after = NULL, purged_at = NULL, updated_at = ? WHERE url = ? AND remove_after = ? AND removed_at IS NULL",
          args: [at, row.url, row.remove_after],
        },
        { sql: "INSERT INTO claim_log (at, url, actor, action, detail) SELECT ?, ?, 'system', 'remove', NULL WHERE changes() > 0", args: [at, row.url] },
        // The quiz pool leaves out removed sites (lib/games/pool.mjs): dropped only when this removal applied
        // (the log row above is written only then, so changes() is 1).
        clearPoolStatement({ onlyAfterChange: true }),
      ],
      "write"
    );
    if (res[0].rowsAffected) urls.push(String(row.url));
  }
  return urls;
}

/**
 * The admin takes a removal back, held or done: the site is listed again.
 * Returns { ok, state, wasRemoved } (wasRemoved: it had taken effect, so the
 * weekly exclusions pull request may already have added it to
 * data/excluded.json; the next weekly run takes the entry out again, see
 * undoneRemovals and pipeline/owner-removals.mjs).
 */
export async function undoRemoval(db, { url, actor, now = new Date() }) {
  const { state: before, urls } = await ownerRow(db, url);
  if (!before.removedAt && !before.removeAfter) return { ok: false, error: "not_removed", state: before };
  const at = iso(now);
  // Every spelling of the site: a removal under another one would keep it hidden.
  await db.batch(
    [
      {
        sql: `UPDATE portfolio_owner SET removed_at = NULL, remove_after = NULL, removed_by = NULL, purged_at = NULL, updated_at = ? WHERE url IN (${urls.map(() => "?").join(", ")})`,
        args: [at, ...urls],
      },
      { sql: "INSERT INTO claim_log (at, url, actor, action, detail) VALUES (?, ?, ?, 'removal_undone', ?)", args: [at, url, actor, JSON.stringify({ removedAt: before.removedAt, removeAfter: before.removeAfter })] },
    ],
    "write"
  );
  return { ok: true, state: await ownerState(db, url), wasRemoved: Boolean(before.removedAt) };
}

/**
 * Sites whose removal the admin undid and that are listed now (no removal
 * since): [{ url, undoneAt }]. The weekly job takes their owner_request
 * entries out of data/excluded.json.
 */
export async function undoneRemovals(db) {
  try {
    return (
      await db.execute(
        `SELECT l.url AS url, MAX(l.at) AS at FROM claim_log l
         JOIN portfolio_owner o ON o.url = l.url
         WHERE l.action = 'removal_undone' AND o.removed_at IS NULL AND o.remove_after IS NULL
         GROUP BY l.url ORDER BY at, l.url`
      )
    ).rows.map((r) => ({ url: String(r.url), undoneAt: String(r.at) }));
  } catch (e) {
    if (/no such table/i.test(String(e?.message ?? e))) return [];
    throw e;
  }
}

/**
 * Audit trail for a restore the weekly job queued: one 'removal_restored'
 * row per undo, however many times the job runs before its pull request
 * merges. Returns the urls newly logged.
 */
export async function logRemovalRestored(db, urls, { now = new Date() } = {}) {
  const logged = [];
  for (const url of urls) {
    const res = await db.execute({
      sql: `INSERT INTO claim_log (at, url, actor, action, detail)
            SELECT ?, ?, 'system', 'removal_restored', ?
            WHERE NOT EXISTS (
              SELECT 1 FROM claim_log r WHERE r.url = ? AND r.action = 'removal_restored'
                AND r.at >= (SELECT MAX(u.at) FROM claim_log u WHERE u.url = ? AND u.action = 'removal_undone'))`,
      args: [iso(now), url, JSON.stringify({ via: "data/excluded.json" }), url, url],
    });
    if (res.rowsAffected) logged.push(url);
  }
  return logged;
}

/** Alert key prefix for held removals (pipeline/alerts.mjs reconcileAlerts scope). */
export const REMOVAL_ALERT = "removal:";
export const isRemovalAlert = (key) => String(key).startsWith(REMOVAL_ALERT);

/** The second key of a held removal asked for again after a cancel in the last day (removalConditions). */
export const AGAIN_SUFFIX = "#again";

/**
 * One owner alert per held removal, while it waits, as before: emailed when
 * it is asked for, then once a day, and cleared when it is cancelled or takes
 * effect. A cancel sends no email by itself: the site stays listed, nothing
 * needs the admin, and it is in the audit log (claim_log remove_cancelled).
 * A removal asked for again after a cancel in the last day says so in one
 * sentence, under its own key (removal:<url>#again): reconcileAlerts sends a
 * key at most once a day and keeps that day across a clear, so under the
 * plain key a request made again the same day would be emailed only the next
 * day, close to when it takes effect. So a site's removals send at most two
 * emails a day however often they are asked for and cancelled.
 * The cancel counts are read only for the sites held now, through the
 * claim_log (url, at) index.
 */
export async function removalConditions(db, { now = new Date() } = {}) {
  const held = await pendingRemovals(db);
  const cancels = new Map();
  if (held.length) {
    const rows = (
      await db.execute({
        sql: `SELECT url, COUNT(*) AS n FROM claim_log
              WHERE url IN (${held.map(() => "?").join(", ")}) AND at > ? AND action = 'remove_cancelled' GROUP BY url`,
        args: [...held.map((p) => p.url), iso(new Date(now).getTime() - REMOVAL_HOLD_MS)],
      })
    ).rows;
    for (const r of rows) cancels.set(String(r.url), Number(r.n));
  }
  return held.map((p) => {
    const n = cancels.get(p.url) ?? 0;
    return {
      key: `${REMOVAL_ALERT}${p.url}${n ? AGAIN_SUFFIX : ""}`,
      kind: "problem",
      title: `Removal requested for ${hostOf(p.url)}`,
      detail:
        `${p.login ? `@${p.login}` : "A verified owner"} asked to remove ${p.url} from PortfolioRank. ` +
        `It takes effect at ${p.removeAfter} unless it is cancelled.\n` +
        (n ? `This removal was cancelled and asked for again ${n} time(s) in the last day.\n` : "") +
        `If this looks wrong, undo it: POST /api/admin/removals {"url": "${p.url}", "action": "undo"} (signed in as the admin), or look at the claim in GET /api/admin/claims.`,
    };
  });
}

/** How far back purgeRemovedProfiles looks: the edge cache keeps a profile a day (worker/edge-cache.ts). */
export const PURGE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Removals that took effect and whose profile hasn't been purged from the
 * edge cache since (portfolio_owner.purged_at): [url], oldest first, at most
 * 100 (one purge call).
 */
export async function unpurgedRemovals(db, { now = new Date() } = {}) {
  return (
    await db.execute({
      sql: `SELECT url FROM portfolio_owner
            WHERE removed_at IS NOT NULL AND removed_at >= ? AND purged_at IS NULL
            ORDER BY removed_at, url LIMIT 100`,
      args: [iso(new Date(now).getTime() - PURGE_LOOKBACK_MS)],
    })
  ).rows.map((r) => String(r.url));
}

/**
 * Purges the profile of every removal that took effect and isn't purged yet
 * (unpurgedRemovals), whatever else the hourly removals task did or failed
 * to do, and sets purged_at only when `purge` says it worked, so a failed
 * purge is tried again the next hour.
 * Returns { purged: [url], failed: [url] }.
 * @param {{ execute: Function, batch: Function }} db
 * @param {{ purge: (urls: string[]) => Promise<boolean>, now?: Date }} args
 */
export async function purgeRemovedProfiles(db, { purge, now = new Date() }) {
  const urls = await unpurgedRemovals(db, { now });
  if (!urls.length) return { purged: [], failed: [] };
  let ok = false;
  try {
    ok = (await purge(urls)) === true;
  } catch {
    ok = false;
  }
  if (!ok) return { purged: [], failed: urls };
  const at = iso(now);
  await db.batch(
    urls.map((url) => ({ sql: "UPDATE portfolio_owner SET purged_at = ? WHERE url = ? AND removed_at IS NOT NULL", args: [at, url] })),
    "write"
  );
  return { purged: urls, failed: [] };
}

/** Sites owners removed: [{ url, removedAt }], for the exclusions pull request. */
export async function ownerRemovals(db) {
  try {
    return (await db.execute("SELECT url, removed_at FROM portfolio_owner WHERE removed_at IS NOT NULL ORDER BY removed_at")).rows.map((r) => ({
      url: String(r.url),
      removedAt: String(r.removed_at),
    }));
  } catch (e) {
    if (/no such table/i.test(String(e?.message ?? e))) return [];
    throw e;
  }
}
