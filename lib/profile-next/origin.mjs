// The hourly path for sites that stop working or come back (worker/index.ts
// purgeNotWorkingProfiles, pipeline/not-working.mjs purgeGoneProfiles) asks
// the app for each profile past the edge and clears a site's mark only once
// the app answers as it should. While the redesigned profile is served
// (PROFILE_NEXT), its page /p/<address>/next must answer the same way, so both
// are asked: the answer counts only when they agree, otherwise 0 (not
// settled, asked again next hour). Pure.

/**
 * @param {(path: string) => Promise<number>} statusOf the app's status for a path
 * @param {{ next: boolean }} opts whether /p/<address>/next is served
 * @returns {(url: string) => Promise<number>}
 */
export function profileOrigin(statusOf, { next }) {
  return async (url) => {
    const path = `/p/${encodeURIComponent(url)}`;
    const profile = Number(await statusOf(path));
    if (!next) return profile;
    const redesigned = Number(await statusOf(`${path}/next`));
    return profile === redesigned ? profile : 0;
  };
}
