// Small helpers for the list's data files and guards, with no dependencies, so
// the feed build, the roster sync and the review scripts can share them
// without loading the database client or the health check.
// (pipeline/exclusions.mjs has its own readJson and excludedUrl; after the
// health lane's pull request #247 it should import these.)
import fs from "node:fs";

/** The owner's one-off allowance for a big upstream cleanup, read from the environment. */
export const CLEANUP_SHARE_ENV = "LIST_CLEANUP_SHARE";

// The most of the list one run may take off it: the feed build refuses a feed
// that drops more of the current entries (before the data pull request is
// opened), and the roster sync refuses to delist more rows. The feed keeps its
// length when upstream rewrites every address, so a count alone never
// notices. Above the weekly exclusions' own 10% cap.
export const DELIST_MAX_SHARE = 0.15;

/** LIST_CLEANUP_SHARE as a share between 0 and 1, or null when unset; anything else is an error. */
export function cleanupShare(env = process.env) {
  const raw = String(env[CLEANUP_SHARE_ENV] ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw new Error(`${CLEANUP_SHARE_ENV}="${raw}" is not a share between 0 and 1 (for example 0.3)`);
  }
  return n;
}

/**
 * A guard's limit as a share: its own default, or the owner's cleanup share
 * when that is larger. The allowance only ever raises a limit.
 */
export function allowedShare(defaultShare, env = process.env) {
  const owner = cleanupShare(env);
  if (defaultShare == null) return owner;
  return owner == null ? defaultShare : Math.max(defaultShare, owner);
}

/** Parsed JSON from `file`, or `fallback` when the file does not exist. */
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e?.code === "ENOENT") return fallback;
    throw e;
  }
}

/** A JSON list file: [] when it does not exist, an error when it holds anything but a list. */
export function readList(file) {
  if (!file) return [];
  const v = readJson(file, []);
  if (!Array.isArray(v)) throw new Error(`${file} is not a JSON list; refusing to use it`);
  return v;
}

/** The address of an exclusions entry (a plain string, or { url, ... }). */
export const excludedUrl = (e) => (typeof e === "string" ? e : e?.url);

/** Appends a section to the job's summary on GitHub Actions (nothing elsewhere). */
export function jobSummary(markdown, env = process.env) {
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
