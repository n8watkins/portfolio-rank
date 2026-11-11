// Claim your portfolio (owner decision 2026-11-10): a GitHub account proves
// it owns a listed portfolio, then may remove it, hide its grade or ask for
// a re-grade. Every step is written to claim_log, the audit log.
//
// Proof, tried in this order:
//   github_link  the portfolio's home page links to github.com/<login>
//                (not accepted for a site built from a known template,
//                whose footer often links the template's author)
//   github_blog  the GitHub profile's Website field points at the
//                portfolio's domain
//   meta         the home page has <meta name="portfoliorank-verify"
//                content="<the claim's token>">
//   manual       a request the site owner reviews by hand
// An account verifies at most MAX_VERIFIED portfolios on its own; more go
// to manual review.
//
// Plain JavaScript: the checks are pure functions over fetched text, and the
// store takes a libSQL client, so the tests need no server or network.

export const META_NAME = "portfoliorank-verify";
export const MAX_VERIFIED = 3;
export const NOTE_MAX = 500;
export const ACTIONS = ["remove", "hide_grade", "show_grade", "regrade"];

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

/** True when the HTML has a link to the GitHub profile of `login` (or one of its repositories). */
export function linksToGithub(html, login) {
  if (!GITHUB_LOGIN.test(String(login ?? ""))) return false;
  const re = new RegExp(`href\\s*=\\s*["']?(?:https?:)?//(?:www\\.)?github\\.com/${escapeRe(login)}(?=[/"'?#\\s>]|$)`, "i");
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
 *   profile   the GitHub user ({ id, login, blog }) or null
 *   ownerId   the signed-in account (gh:<numeric id>)
 *   template  the template the site was built from (portfolios.facts), or null
 * @param {{ url: string, page: { html: string, finalUrl: string } | null, profile: { id: number, login: string, blog: string | null } | null, ownerId: string, login: string, template?: string | null }} args
 */
export function autoProof({ url, page, profile, ownerId, login, template = null }) {
  const host = hostOf(url);
  // The page must still be the portfolio: a redirect elsewhere proves nothing.
  if (page && !template && hostOf(page.finalUrl) === host && linksToGithub(page.html, login)) return "github_link";
  if (profile && `gh:${profile.id}` === ownerId && profile.blog && hostOf(profile.blog) === host) return "github_blog";
  return null;
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

const claimOf = (r) =>
  r && {
    id: Number(r.id),
    url: String(r.url),
    owner: String(r.owner),
    login: String(r.login),
    status: String(r.status),
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
  return Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM claims WHERE owner = ? AND status = 'verified'", args: [owner] })).rows[0].n);
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

/** True when `owner` holds a verified claim on `url`. */
export async function isVerifiedOwner(db, { url, owner }) {
  const r = await db.execute({ sql: "SELECT 1 FROM claims WHERE url = ? AND owner = ? AND status = 'verified'", args: [url, owner] });
  return r.rows.length > 0;
}

/** What owners chose for a site: { hideGrade, removedAt }. */
export async function ownerState(db, url) {
  const r = (await db.execute({ sql: "SELECT hide_grade, removed_at FROM portfolio_owner WHERE url = ?", args: [url] })).rows[0];
  return { hideGrade: Number(r?.hide_grade ?? 0) === 1, removedAt: r?.removed_at == null ? null : String(r.removed_at) };
}

/**
 * A verified owner's action on their portfolio, logged:
 *   remove      hidden from the site at once; the weekly health workflow
 *               moves it to data/excluded.json ("owner request") through
 *               its bot pull request (pipeline/owner-removals.mjs)
 *   hide_grade  the AI grade is no longer shown; show_grade undoes it
 *   regrade     a request for the grade service, which applies its own
 *               cooldown; one open request per site
 * Returns { ok: true, state, regrade? } or { ok: false, error }.
 */
export async function ownerAction(db, { url, owner, action, now = new Date() }) {
  if (!ACTIONS.includes(action)) return { ok: false, error: "bad_action" };
  if (!(await isVerifiedOwner(db, { url, owner }))) return { ok: false, error: "not_owner" };
  const at = iso(now);
  if (action === "regrade") {
    const res = await db.execute({
      sql: `INSERT INTO regrade_requests (url, requested_by, requested_at, status)
            SELECT ?, ?, ?, 'pending' WHERE NOT EXISTS (SELECT 1 FROM regrade_requests WHERE url = ? AND status = 'pending')`,
      args: [url, owner, at, url],
    });
    const queued = res.rowsAffected > 0;
    await logClaim(db, { url, actor: owner, action: queued ? "regrade_requested" : "regrade_already_pending", now });
    return { ok: true, state: await ownerState(db, url), regrade: { queued, pending: true } };
  }
  const set =
    action === "remove"
      ? { col: "removed_at = COALESCE(portfolio_owner.removed_at, excluded.removed_at), removed_by = COALESCE(portfolio_owner.removed_by, excluded.removed_by)", hide: 0, removed: at }
      : { col: "hide_grade = excluded.hide_grade", hide: action === "hide_grade" ? 1 : 0, removed: null };
  await db.batch(
    [
      {
        sql: `INSERT INTO portfolio_owner (url, hide_grade, removed_at, removed_by, updated_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(url) DO UPDATE SET ${set.col}, updated_at = excluded.updated_at`,
        args: [url, set.hide, set.removed, action === "remove" ? owner : null, at],
      },
      { sql: "INSERT INTO claim_log (at, url, actor, action, detail) VALUES (?, ?, ?, ?, NULL)", args: [at, url, owner, action] },
    ],
    "write"
  );
  return { ok: true, state: await ownerState(db, url) };
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
