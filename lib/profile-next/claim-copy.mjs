// What claiming a portfolio offers, in one place: /claim's own introduction
// (app/claim/page.tsx) and the redesigned profile's "Claim it" card
// (components/profile-next) both read it, by the same switch the claim page
// decides its flow by, so the card only promises what /claim offers:
//
//   TOOLS_ENABLED on   the code you deploy (components/claim/VerifyFlow.tsx):
//                      sign in with GitHub; a GitHub Pages site of your own
//                      account is verified at once, else a file or a meta tag
//                      and Verify. Then re-check (app/api/recheck), hide the
//                      grade or remove it.
//   TOOLS_ENABLED off  the older flow (components/claim/ClaimFlow.tsx): a link
//                      to your GitHub profile on the site, or a meta tag; hiding
//                      the grade and removing the site need the tag even when
//                      the link verified the claim (lib/games/claims.mjs
//                      hide_needs_meta, remove_needs_meta).
// Pure.

/** /claim's introduction: how to prove a portfolio is yours and what that lets you do. */
export function claimIntro(tools) {
  return tools
    ? "First prove it's yours: put a short code we give you on your site. Then you can re-check it, hide its grade or remove it."
    : "First prove it's yours: a link to your GitHub profile on the site, or a short code you add to the page. Then, with the code, you can hide its grade or remove it.";
}

/**
 * The profile card's two lines: what claiming offers (the claim page's own introduction) and how it starts.
 * @param {{ tools: boolean }} switches
 * @returns {{ can: string, steps: string }}
 */
export function claimCopy({ tools }) {
  return {
    can: claimIntro(tools),
    steps: tools
      ? "To claim: sign in with GitHub. A GitHub Pages site of your own account is verified at once; otherwise add a small file or one meta tag to your site and press Verify."
      : "To claim: sign in with GitHub, then prove it on the claim page.",
  };
}
