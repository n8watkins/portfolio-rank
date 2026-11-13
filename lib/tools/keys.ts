// Where each tool's result is saved in the cache table: the same keys the
// profile (psi), the grader (grader:quick) and the "to improve" list read.

/** Lighthouse: "psi:<url>" (mobile, what /api/psi and the profile read) and "psi-desktop:<url>". */
export const psiKey = (strategy: "mobile" | "desktop", url: string) => (strategy === "mobile" ? `psi:${url}` : `psi-desktop:${url}`);

/** The share preview checker. */
export const shareKey = (url: string) => `share:${url}`;

/** "Grade my portfolio"'s free checks (lib/grader/quick.ts quickFacts), keyed by site key. */
export const quickKey = (siteKey: string) => `grader:quick:${siteKey}`;
