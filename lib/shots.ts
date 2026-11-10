import { db, ensureSchema } from "@/lib/db";
import { frameOf } from "@/lib/shot-url";

// Our own Playwright captures (pipeline/capture.mjs) are served from
// SHOTS_BASE_URL: in production "/shots" on our own domain, answered by the
// Worker from the R2 bucket with long edge and browser caching
// (worker/assets.ts); in `next dev` the same path is app/shots. Unset, the UI
// falls back to mShots (free, slow, desktop-only).
export function mshotsUrl(url: string, w = 900): string {
  return `https://s.wordpress.com/mshots/v1/${encodeURIComponent(url)}?w=${w}&vpw=1440&vph=900`;
}

// Build per-file URLs from a capture base (see shotBases).
export const heroOf = (base: string) => frameOf(base, "hero.jpg");
export const mobileOf = (base: string) => frameOf(base, "mobile.jpg");
export const fullOf = (base: string) => frameOf(base, "full.jpg");

/** A short version tag for a capture: its time, in base 36. */
function versionOf(capturedAt: unknown): string | null {
  const ms = typeof capturedAt === "string" ? Date.parse(capturedAt.includes("T") ? capturedAt : `${capturedAt.replace(" ", "T")}Z`) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000).toString(36) : null;
}

/**
 * Map url → our capture base (`${base}/${shot_key}?v=<capture time>`) for the
 * captured roster URLs. Callers pick the frame they want (heroOf/mobileOf/
 * fullOf, or frameOf on the client). The version changes with every recapture
 * (shot_key doesn't), which is what makes immutable caching safe.
 */
export async function shotBases(urls: string[]): Promise<Map<string, string>> {
  const base = process.env.SHOTS_BASE_URL;
  const out = new Map<string, string>();
  if (!base || urls.length === 0) return out;
  await ensureSchema();
  const placeholders = urls.map(() => "?").join(",");
  const res = await db().execute({
    sql: `SELECT url, shot_key, captured_at FROM portfolios
          WHERE url IN (${placeholders}) AND shot_key IS NOT NULL`,
    args: urls,
  });
  for (const r of res.rows) {
    const v = versionOf(r.captured_at);
    out.set(String(r.url), `${base}/${r.shot_key}${v ? `?v=${v}` : ""}`);
  }
  return out;
}
