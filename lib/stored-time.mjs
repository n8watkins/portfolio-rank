// A time as the database stores it, in milliseconds: SQLite's datetime('now')
// ("YYYY-MM-DD HH:MM:SS", UTC, no zone) or ISO 8601. No imports, so the
// Worker (lib/reviews/stored-capture.mjs) and the pipeline scripts
// (pipeline/evidence.mjs) share it.

/** The stored time `v` in milliseconds, or null when there is none or it does not parse. */
export function storedMs(v) {
  if (v == null || v === "") return null;
  const s = String(v);
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? t : null;
}
