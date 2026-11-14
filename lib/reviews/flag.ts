// The review queue's automatic apply (lib/reviews/store.mjs autoApplyReviews,
// the owner's rule: "if something passes the test, I don't need to review
// it; only if it fails") has a launch switch: REVIEW_AUTO_APPLY in
// wrangler.jsonc, "false" in production and on staging until the owner turns
// it on. While it is off, the hourly cron applies nothing by itself and every
// row waits for the owner on /admin/review, as before.

/** The switch from a Worker env (or process.env). */
export const reviewAutoApplyEnabled = (env: { REVIEW_AUTO_APPLY?: string } = process.env) => /^true$/i.test(String(env.REVIEW_AUTO_APPLY ?? ""));
