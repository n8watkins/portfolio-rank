import { db, ensureSchema } from "@/lib/db";

// Our own Playwright captures (pipeline/capture.mjs → R2). Falls back to
// mShots in the UI until SHOTS_BASE_URL (public R2 bucket URL) is set and
// the site has been captured.
export function mshotsUrl(url: string, w = 900): string {
  return `https://s.wordpress.com/mshots/v1/${encodeURIComponent(url)}?w=${w}&vpw=1440&vph=900`;
}

/** Map url → our hero-shot URL for the given roster URLs (only captured ones). */
export async function shotUrls(
  urls: string[]
): Promise<Map<string, string>> {
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
    out.set(String(r.url), `${base}/${r.shot_key}/hero.jpg`);
  }
  return out;
}
