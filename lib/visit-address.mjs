// Where a profile's "Visit" link goes (app/p/[slug]): the listed address, or,
// while the health check has found the listed address failing and the site
// answering at its own www or https form (health_marks.answers_at,
// pipeline/health.mjs sameSiteAddress), that working address, so visitors
// reach the site. No imports: the app and the tests share it.

/**
 * `answersAt` when it is set and the same page as `url` written another way
 * (the scheme or a leading www, the same path), else `url`.
 * @param {string} url
 * @param {unknown} answersAt
 * @returns {string}
 */
export function visitAddress(url, answersAt) {
  if (answersAt == null || answersAt === "") return url;
  try {
    const a = new URL(url);
    const b = new URL(String(answersAt));
    const host = (u) => u.hostname.toLowerCase().replace(/^www\./, "");
    const path = (u) => u.pathname.replace(/\/+$/, "");
    return /^https?:$/.test(b.protocol) && host(a) === host(b) && path(a) === path(b) ? b.href : url;
  } catch {
    return url;
  }
}
