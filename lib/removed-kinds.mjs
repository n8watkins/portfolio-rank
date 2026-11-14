// The kinds of entry in data/excluded.json and how /removed labels them
// (app/removed/page.tsx). pipeline/exclusions.mjs documents the fields.
//   down           confirmed down by the weekly health check
//   dead           gone: the name no longer resolves, or a 404 or broken
//                  deploy; checked again every few months (recheck_after)
//   duplicate      another address of a site kept under one (duplicate_of)
//   not_portfolio  not a portfolio: graded so, settled by a code rule, or
//                  decided by the owner
//   owner_request  taken off at the owner's request: counted, never named
export const REMOVED_KINDS = {
  down: "Site down",
  dead: "Site gone",
  duplicate: "Duplicate",
  not_portfolio: "Not a portfolio",
};

export const EXCLUSION_KINDS = [...Object.keys(REMOVED_KINDS), "owner_request"];
