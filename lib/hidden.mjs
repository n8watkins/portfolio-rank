// Which roster sites the site does not show (browse, matchups, leaderboards),
// as one SQL condition on portfolios, shared by the app (lib/roster.ts) and
// the ranking recompute (lib/ranking/store.mjs assignShownRanks):
// - confirmed down by the weekly health check (pipeline/health.mjs);
// - a failed capture (dead/parked/error) the health check hasn't cleared yet.
// "Suspect" sites stay visible: one failed check proves nothing.
// COALESCE keeps it true or false, never NULL, so NOT (...) is safe too.
export const HIDDEN_WHERE = "COALESCE(health, '') = 'down' OR (status IN ('dead', 'parked', 'error') AND COALESCE(health, '') != 'live')";
