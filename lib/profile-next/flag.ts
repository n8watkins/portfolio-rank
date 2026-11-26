// The redesigned profile (the owner's "Banner" pick, 2026-11-25) has a launch
// switch: PROFILE_NEXT in wrangler.jsonc, "false" until it replaces today's
// profile. While it is off, /p/<address>/next and its share card answer 404;
// on, they render, noindex, outside the sitemap and linked from nowhere.
// next.config.ts sets it on the server from the build's environment or
// wrangler.jsonc, and the Worker sets the same value at run time.

/** The switch from a Worker env (or process.env). */
export const profileNextEnabled = (env: { PROFILE_NEXT?: string } = process.env) => /^true$/i.test(String(env.PROFILE_NEXT ?? ""));
