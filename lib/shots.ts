import { db, ensureSchema } from "@/lib/db";
import { frameOf, fullPageFrames, type FullPagePreview } from "@/lib/shot-url";
import { fullPagePreviewEnabled } from "@/lib/fullpage-flag";

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

/**
 * A site's full-page frames, desktop and phone, for the report card's "see
 * the whole page" preview: null while FULLPAGE_PREVIEW_ENABLED is off (no
 * database read, so nothing links to them), without SHOTS_BASE_URL, or when
 * the site has no complete pair yet (pipeline/fullpage-backfill.mjs).
 */
export async function fullPagePreview(url: string, env = process.env): Promise<FullPagePreview | null> {
  const base = env.SHOTS_BASE_URL;
  if (!fullPagePreviewEnabled(env) || !base) return null;
  await ensureSchema();
  const row = (
    await db().execute({ sql: "SELECT shot_key, meta FROM portfolios WHERE url = ? AND shot_key IS NOT NULL", args: [url] })
  ).rows[0];
  if (!row) return null;
  let meta: { fullPage?: unknown } | null = null;
  try {
    meta = JSON.parse(String(row.meta ?? "null"));
  } catch {
    return null;
  }
  return fullPageFrames(`${base}/${row.shot_key}`, meta?.fullPage);
}

/** A short version tag for a capture: its time, in base 36. */
function versionOf(capturedAt: unknown): string | null {
  const ms = typeof capturedAt === "string" ? Date.parse(capturedAt.includes("T") ? capturedAt : `${capturedAt.replace(" ", "T")}Z`) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000).toString(36) : null;
}

/**
 * Map url → our capture base (`${base}/${shot_key}?v=<capture time>`) for the
 * captured roster URLs. Callers pick the frame they want (heroOf/mobileOf,
 * or frameOf on the client; full-page frames come from fullPagePreview). The version changes with every recapture
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
