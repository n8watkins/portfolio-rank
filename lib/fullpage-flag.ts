// The report card's "see the whole page" preview has a launch switch:
// FULLPAGE_PREVIEW_ENABLED in wrangler.jsonc, "false" in production and on
// staging until its UI ships. The capture stores the full-page frames
// (pipeline/fullpage.mjs) and the Worker serves them (worker/shots.ts)
// either way; while the switch is off no page links to them, because
// lib/shots.ts fullPagePreview answers null without reading anything.
// next.config.ts inlines it as NEXT_PUBLIC_FULLPAGE_PREVIEW_ENABLED for the browser.

/** The switch as the browser and the build see it. */
export const FULLPAGE_PREVIEW_UI = process.env.NEXT_PUBLIC_FULLPAGE_PREVIEW_ENABLED === "true";

/** The switch from a Worker env (or process.env). */
export const fullPagePreviewEnabled = (env: { FULLPAGE_PREVIEW_ENABLED?: string } = process.env) =>
  /^true$/i.test(String(env.FULLPAGE_PREVIEW_ENABLED ?? ""));
