// The claim pages' decisions, as plain functions with no imports so the unit
// tests can check them (tests/ownership-proof.test.mjs): ClaimFlow.tsx and
// VerifyFlow.tsx draw what these say.

/**
 * What a held removal's page offers this account: "cancel" when its proof can
 * cancel (control proof, lib/games/claims.mjs; the claim's `removable`), else
 * "prove": the same proof step removal uses, which leads back here.
 */
export const scheduledAction = (claim: { removable: boolean }): "cancel" | "prove" => (claim.removable ? "cancel" : "prove");

/** Where proving control leads: back to a removal that waits, else on to confirming one. */
export const afterProof = (state: { removedAt: string | null; removeAfter: string | null }): "removed" | "scheduled" | "confirm-remove" =>
  state.removedAt ? "removed" : state.removeAfter ? "scheduled" : "confirm-remove";

/** Why a verify answer (POST /api/owner/verify) didn't verify, in words. */
export const VERIFY_REASONS: Record<string, string> = {
  not_found: "We didn't find it yet. Check it's deployed at exactly that address, then verify again.",
  off_site: "The site redirected to another site, so we couldn't check it.",
  too_many_redirects: "The site redirected too many times.",
  unreachable: "We couldn't reach the site just now.",
  timeout: "The site took longer than 5 seconds to answer.",
  review: "We found your proof. Because of this account's age or how many sites it has claimed, we check this one by hand before it's verified. There's nothing more to do for now.",
  rejected: "This claim wasn't accepted after a review. Ask through GitHub if you think that's wrong.",
  account_too_new: "We found it, but your GitHub account is too new for owner tools. Verify again once it's older.",
};

/**
 * The message for a verify answer's reason, on every answer including the
 * first one when the page loads ("start"), so a claim held for review or
 * rejected shows as such after a reload. "" when there is no reason.
 */
export const verifyMessage = (reason: unknown): string => (reason ? (VERIFY_REASONS[String(reason)] ?? VERIFY_REASONS.not_found) : "");
