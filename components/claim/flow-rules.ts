// The claim pages' decisions, as plain functions with no imports so the unit
// tests can check them (tests/ownership-proof.test.mjs): ClaimFlow.tsx draws
// what these say.

/**
 * What a held removal's page offers this account: "cancel" when its proof can
 * cancel (control proof, lib/games/claims.mjs; the claim's `removable`), else
 * "prove": the same proof step removal uses, which leads back here.
 */
export const scheduledAction = (claim: { removable: boolean }): "cancel" | "prove" => (claim.removable ? "cancel" : "prove");

/** Where proving control leads: back to a removal that waits, else on to confirming one. */
export const afterProof = (state: { removedAt: string | null; removeAfter: string | null }): "removed" | "scheduled" | "confirm-remove" =>
  state.removedAt ? "removed" : state.removeAfter ? "scheduled" : "confirm-remove";
