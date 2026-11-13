// "When checks re-run" (lib/freshness.mjs, AUTOMATION.md) has a launch switch:
// FRESHNESS_ENABLED in wrangler.jsonc, "false" in production and "true" on
// staging. While it is off, the hourly cron makes no fingerprint fetches
// (worker/freshness.ts) and profiles say "Measured on" as before, without
// "site unchanged since" or "re-measuring" (components/Diagnostics.tsx).
// next.config.ts inlines it as NEXT_PUBLIC_FRESHNESS_ENABLED for the browser.

/** The switch as the browser and the build see it. */
export const FRESHNESS_UI = process.env.NEXT_PUBLIC_FRESHNESS_ENABLED === "true";

/** The switch from a Worker env (or process.env). */
export const freshnessEnabled = (env: { FRESHNESS_ENABLED?: string } = process.env) => /^true$/i.test(String(env.FRESHNESS_ENABLED ?? ""));
