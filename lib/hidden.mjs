// Which roster sites the site does not show (browse, matchups, leaderboards),
// as one SQL condition on portfolios, shared by the app (lib/roster.ts) and
// the ranking recompute (lib/ranking/store.mjs assignShownRanks):
// - not working, or confirmed down, by the health check (health 'down':
//   pipeline/not-working.mjs, pipeline/health.mjs);
// - a failed capture (dead/parked/error) the health check hasn't cleared yet.
// "Suspect" sites (failing, not yet confirmed) stay visible; they are out of
// the AI's work only (pipeline/roster.mjs ACTIVE).
// COALESCE keeps it true or false, never NULL, so NOT (...) is safe too.
export const HIDDEN_WHERE = "COALESCE(health, '') = 'down' OR (status IN ('dead', 'parked', 'error') AND COALESCE(health, '') != 'live')";

// The hidden sites that have no profile at all: not working or confirmed down
// (owner, 2026-11-16: "if it's not working, it's not in the profile"). Their
// page answers the site's normal not found (lib/roster.ts isGone). A failed
// capture alone keeps its page (noindex) while the capture is retried.
export const GONE_WHERE = "COALESCE(health, '') = 'down'";

// A partial index holding only the hidden sites, so the app's hidden set
// (lib/roster.ts hiddenUrls, every few minutes in every isolate) reads those
// few rows instead of scanning every portfolio: at 50,000 sites the scan
// alone would pass Turso Free's 500 million rows read a month. SQLite uses
// it only when a query's WHERE is exactly HIDDEN_WHERE. Created by
// pipeline/roster.mjs ensureRosterSchema (every capture and health run) and
// by a new database's migration (lib/schema.mjs).
export const HIDDEN_INDEX = `CREATE INDEX IF NOT EXISTS portfolios_hidden_idx ON portfolios (url) WHERE ${HIDDEN_WHERE}`;
