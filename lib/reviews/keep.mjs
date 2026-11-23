// The owner has decided to keep a site: he rejected a proposal to remove it
// (in any group), or he confirmed it is a portfolio himself. A rule's
// decision never counts. One definition, in JavaScript for the door and in
// SQL for the night's collapse rows and the tiers' library
// (lib/tiers-store.mjs: a site with too few portfolio signals is still ranked
// when the owner kept it). A leaf module, so the tiers can read it without
// importing the review queue (./store.mjs imports the tiers).

/** Whether a decider is a rule (anything recorded as "rule:..."), not a person. */
export const isRuleActor = (by) => String(by ?? "").startsWith("rule:");

/** SQL (never NULL): the status_reviews row aliased `k` is the owner's decision to keep its site. */
export const KEEP_ROW_SQL = (k) =>
  `((${k}.status = 'rejected' AND ${k}.proposed = 'remove') OR (${k}.status = 'confirmed' AND ${k}.proposed = 'relist' AND COALESCE(${k}.decided_by, '') NOT LIKE 'rule:%'))`;

/** Whether one review row (./store.mjs reviewOf) is the owner's decision to keep its site. */
export const keepsSite = (r) => (r.status === "rejected" && r.proposed === "remove") || (r.status === "confirmed" && r.proposed === "relist" && !isRuleActor(r.decidedBy));

/** Whether the owner has decided to keep the site these rows are about (ever). */
export const ownerKeepsSite = (rows) => rows.some(keepsSite);
