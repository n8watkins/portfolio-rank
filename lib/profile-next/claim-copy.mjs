// What the redesigned profile's "Claim it" card says, from the same switches
// /claim decides its flow by (app/claim/page.tsx), so it only promises what
// the claim page offers in the running configuration:
//
//   TOOLS_ENABLED on   the code you deploy (components/claim/VerifyFlow.tsx):
//                      sign in with GitHub; a GitHub Pages site of your own
//                      account is verified at once, else a file or a meta tag
//                      and Verify. Then re-check (app/api/recheck), hide the
//                      grade or remove it.
//   TOOLS_ENABLED off  the older flow (components/claim/ClaimFlow.tsx): sign in
//                      with GitHub; verified at once when the site links to
//                      your GitHub profile, else a one-line meta tag. Then
//                      remove it or hide its grade, and ask for a re-grade
//                      while the games are on (GAMES_V2).
// Pure.

/**
 * @param {{ tools: boolean, games: boolean }} switches
 * @returns {{ can: string, steps: string }}
 */
export function claimCopy({ tools, games }) {
  if (tools) {
    return {
      can: "Claim it to re-check the site, hide its grade or remove it.",
      steps: "To claim: sign in with GitHub. A GitHub Pages site of your own account is verified at once; otherwise add a small file or one meta tag to your site and press Verify.",
    };
  }
  return {
    can: games ? "Claim it to remove it from PortfolioRank, hide its grade or ask for a re-grade." : "Claim it to remove it from PortfolioRank or hide its grade.",
    steps: "To claim: sign in with GitHub. It is verified at once when the site links to your GitHub profile; otherwise add a one-line meta tag to your site.",
  };
}
