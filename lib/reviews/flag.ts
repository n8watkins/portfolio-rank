// The review queue's automatic apply (lib/reviews/store.mjs autoApplyReviews,
// the owner's rule: "if something passes the test, I don't need to review
// it; only if it fails") has a launch switch: REVIEW_AUTO_APPLY in
// wrangler.jsonc, "true" in production and on staging since the owner's
// decision ("If the graders agreed, it should be confirmed automatically").
// Set to "false", the hourly cron applies nothing by itself and every row
// waits for the owner on /admin/review.

/** The switch from a Worker env (or process.env). */
export const reviewAutoApplyEnabled = (env: { REVIEW_AUTO_APPLY?: string } = process.env) => /^true$/i.test(String(env.REVIEW_AUTO_APPLY ?? ""));
