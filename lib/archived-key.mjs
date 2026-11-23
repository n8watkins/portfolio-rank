// The closed-off key an old site's rows move to when its address comes back
// from the archive as a new site (pipeline/archive-return.mjs; owner,
// 2026-11-23: "We don't know if it's the same thing"). Never a web address, so
// nothing lists it; pages that read a person's own history (votes, face-offs)
// show it as a site no longer listed, with no link. No imports, so the app and
// the pipeline share it.

export const ARCHIVED_PREFIX = "archived:";

/** The closed-off key for `url` retired on `day` (YYYY-MM-DD). */
export const archivedKey = (url, day) => `${ARCHIVED_PREFIX}${day}:${url}`;

/** Whether an address is such a key (never a site). */
export const isArchivedKey = (url) => String(url ?? "").startsWith(ARCHIVED_PREFIX);

/** SQL (never NULL): the column `col` is not such a key. */
export const NOT_ARCHIVED_SQL = (col) => `substr(COALESCE(${col}, ''), 1, ${ARCHIVED_PREFIX.length}) != '${ARCHIVED_PREFIX}'`;

/** How a person's own history names an old site behind such a key. */
export const NO_LONGER_LISTED = "a site no longer listed";
