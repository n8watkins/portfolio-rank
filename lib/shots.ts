import { db, ensureSchema } from "@/lib/db";

// Our own Playwright captures (pipeline/capture.mjs) are served from
// SHOTS_BASE_URL — the public R2 bucket in prod, or the local `/shots` route
// in dev (see app/shots/[key]/[file]/route.ts). Until that's set, the UI falls
// back to mShots (free, slow, desktop-only).
export function mshotsUrl(url: string, w = 900): string {
  return `https://s.wordpress.com/mshots/v1/${encodeURIComponent(url)}?w=${w}&vpw=1440&vph=900`;
}

// Build per-file URLs from a capture base (`${SHOTS_BASE_URL}/${shot_key}`).
export const heroOf = (base: string) => `${base}/hero.jpg`;
export const mobileOf = (base: string) => `${base}/mobile.jpg`;
export const fullOf = (base: string) => `${base}/full.jpg`;

/**
 * Map url → our capture base URL (`${base}/${shot_key}`) for the captured
 * roster URLs. Callers pick the frame they want (heroOf/mobileOf/fullOf).
 */
export async function shotBases(urls: string[]): Promise<Map<string, string>> {
  const base = process.env.SHOTS_BASE_URL;
  const out = new Map<string, string>();
  if (!base) return out;
  await ensureSchema();
  const placeholders = urls.map(() => "?").join(",");
  const res = await db().execute({
    sql: `SELECT url, shot_key FROM portfolios
          WHERE url IN (${placeholders}) AND shot_key IS NOT NULL`,
    args: urls,
  });
  for (const r of res.rows) {
    out.set(String(r.url), `${base}/${r.shot_key}`);
  }
  return out;
}
