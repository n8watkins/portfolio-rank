// The hourly path for sites that stop working or come back (worker/index.ts
// purgeNotWorkingProfiles, pipeline/not-working.mjs purgeGoneProfiles) asks
// the app for each profile past the edge and clears a site's mark only once
// the app answers as it should. The current profile decides. While the
// redesigned profile is served (PROFILE_NEXT), its page /p/<address>/next is
// asked too (which also renders it again past the edge), and when it answers
// otherwise, or fails, that is logged as one structured line: it never holds
// the mark, so one broken page cannot keep a site purged and reloaded every
// hour. Pure, apart from the log it is given.

/**
 * @param {(path: string) => Promise<number>} statusOf the app's status for a path
 * @param {{ next: boolean, log?: (line: Record<string, unknown>) => void }} opts whether /p/<address>/next is served
 * @returns {(url: string) => Promise<number>} the current profile's status
 */
export function profileOrigin(statusOf, { next, log = () => {} }) {
  return async (url) => {
    const path = `/p/${encodeURIComponent(url)}`;
    const profile = Number(await statusOf(path));
    if (!next) return profile;
    let redesigned = 0;
    let error = null;
    try {
      redesigned = Number(await statusOf(`${path}/next`));
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 200);
    }
    if (error || redesigned !== profile) log({ event: "profile_next.origin_disagrees", url, profile, next: redesigned, ...(error ? { error } : {}) });
    return profile;
  };
}
