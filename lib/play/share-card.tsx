import feed from "@/data/feed.json";
import type { Portfolio } from "@/app/page";
import { OG_SIZE, dataUrl, shareCard } from "@/lib/og-card";
import { readPublicFile } from "@/lib/publicFile";
import { db, ensureSchema } from "@/lib/db";
import { isHidden } from "@/lib/roster";
import { playCards } from "@/lib/play/card";
import { readGradeShot } from "@/lib/grader/server";
import { TierChip } from "@/lib/og-tier";
import { tierLabel } from "@/lib/tiers.mjs";
import { SITE_HOST } from "@/lib/site";

// A listed portfolio's share card: its name, its public grade and "top N%"
// (top tiers only, as on the page) beside its own screenshot. It is the
// portfolio page's Open Graph image (app/p/[slug]/opengraph-image.tsx). The
// shared card design (the report lane's lib/og-portfolio.tsx) replaces the
// drawing below when it lands.

export const SHARE_SIZE = OG_SIZE;

const amber = "#fbbf24";

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** The capture's hero frame: from the bucket, or (under `next dev` with an absolute SHOTS_BASE_URL) over HTTP. */
async function heroBytes(shotKey: string): Promise<Uint8Array | null> {
  const fromBucket = await readGradeShot(shotKey, "hero.jpg").catch(() => null);
  if (fromBucket) return fromBucket;
  const base = process.env.SHOTS_BASE_URL ?? "";
  if (!/^https?:\/\//.test(base)) return null;
  const res = await fetch(`${base}/${shotKey}/hero.jpg`).catch(() => null);
  return res?.ok ? new Uint8Array(await res.arrayBuffer()) : null;
}

async function portfolio(url: string) {
  const p = (feed as Portfolio[]).find((x) => x.url === url);
  if (!p || (await isHidden(url))) return null;
  await ensureSchema();
  const row = (await db().execute({ sql: "SELECT shot_key FROM portfolios WHERE url = ?", args: [url] })).rows[0];
  const card = (await playCards([url])).get(url)!;
  const shot = row?.shot_key ? await heroBytes(String(row.shot_key)) : null;
  return { name: p.name, tagline: p.tagline ?? null, domain: domainOf(url), card, shot };
}

export async function listedShareCard(url: string): Promise<Response> {
  const [medium, extraBold, mark, n8, p] = await Promise.all([
    readPublicFile("/og/Inter-Medium.ttf"),
    readPublicFile("/og/Inter-ExtraBold.ttf"),
    readPublicFile("/og/pr-logo.svg"),
    readPublicFile("/og/n8-icon.png"),
    portfolio(url),
  ]);

  const name = p ? p.name : "PortfolioRank";
  const tier = p?.card.tier ?? null;
  const tagline = !p
    ? "The best developer portfolios, ranked."
    : tier && p.card.topPct
      ? `${p.domain}: tier ${tierLabel(tier)}, top ${p.card.topPct}% of graded developer portfolios.`
      : `${p.domain}, a developer portfolio on PortfolioRank.`;

  return shareCard({
    colors: {
      bg: "#0a0a0b",
      bgImage: "radial-gradient(circle at 80% 40%, rgba(251,191,36,0.14), rgba(10,10,11,0) 55%)",
      ink: "#ededf0",
      muted: "#8b8b93",
      body: "#c4c4cb",
      accent: amber,
    },
    font: "Inter",
    fonts: [
      { name: "Inter", data: medium, weight: 500 },
      { name: "Inter", data: extraBold, weight: 800 },
    ],
    logo: dataUrl(mark, "image/svg+xml"),
    n8Icon: dataUrl(n8, "image/png"),
    host: SITE_HOST,
    name,
    nameSize: name.length > 22 ? 46 : name.length > 14 ? 58 : 72,
    nameTracking: -1.6,
    tagline,
    visual: (
      <div style={{ display: "flex", position: "absolute", left: 628, top: 120, width: 640, height: 430 }}>
        {p?.shot ? (
          // eslint-disable-next-line @next/next/no-img-element -- drawn by ImageResponse, not a page
          <img
            src={dataUrl(p.shot.buffer.slice(p.shot.byteOffset, p.shot.byteOffset + p.shot.byteLength) as ArrayBuffer, "image/jpeg")}
            width={640}
            height={400}
            alt=""
            style={{ borderRadius: 18, border: "1.5px solid #26262b", boxShadow: "0 30px 70px rgba(0,0,0,0.55)", objectFit: "cover", objectPosition: "top" }}
          />
        ) : (
          <div style={{ display: "flex", width: 640, height: 400, borderRadius: 18, border: "1.5px solid #26262b", background: "#121215" }} />
        )}
        {tier && (
          <TierChip tier={tier} style={{ position: "absolute", left: -36, bottom: 0 }} />
        )}
      </div>
    ),
  });
}
