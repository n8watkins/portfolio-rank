import { dataUrl, shareCard } from "@/lib/og-card";
import { readPublicFile } from "@/lib/publicFile";
import { db } from "@/lib/db";
import { loadProfile } from "@/lib/profile";
import { loadProfileTier } from "@/lib/tiers-view";
import { familyOf, tierLabel } from "@/lib/tiers.mjs";
import { readGradeShot } from "@/lib/grader/server";
import { SITE_HOST } from "@/lib/site";
import { profileNextEnabled } from "@/lib/profile-next/flag";

// The redesigned profile's share card (1200 by 630, lib/og-card.tsx, the grid
// every n8builds card uses): the portfolio's name and role beside its own
// screenshot, with its tier tile while tiers are shown, as the grade report's
// card draws it (app/grade/[id]/opengraph-image.tsx). The page shows it under
// "Is this your portfolio? Claim it or share it" and names it as its Open
// Graph image. A 404 while PROFILE_NEXT is off, like the page.

const amber = "#fbbf24";
const TIER_BG: Record<string, string> = { S: amber, A: "#3a2a0a", B: "#1c1c21", C: "#1c1c21", D: "#1c1c21" };
const TIER_INK: Record<string, string> = { S: "#0a0a0b", A: amber, B: "#ededf0", C: "#ededf0", D: "#8b8b93" };

/** The site's top screenful (hero.jpg): from the bucket on the Worker, else from SHOTS_BASE_URL when it is a full address (local runs). */
async function heroShot(url: string): Promise<Uint8Array | null> {
  const row = (await db().execute({ sql: "SELECT shot_key FROM portfolios WHERE url = ? AND shot_key IS NOT NULL", args: [url] })).rows[0];
  if (!row) return null;
  const key = String(row.shot_key);
  const fromBucket = await readGradeShot(key, "hero.jpg").catch(() => null);
  if (fromBucket) return fromBucket;
  const base = process.env.SHOTS_BASE_URL ?? "";
  if (!/^https?:\/\//.test(base)) return null;
  const res = await fetch(`${base.replace(/\/+$/, "")}/${key}/hero.jpg`).catch(() => null);
  return res?.ok ? new Uint8Array(await res.arrayBuffer()) : null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (!profileNextEnabled()) return new Response("Not found", { status: 404 });
  const url = decodeURIComponent((await params).slug);
  const p = await loadProfile(url);
  if (!p || p.gone) return new Response("Not found", { status: 404 });
  const [medium, extraBold, mark, n8, t, shot] = await Promise.all([
    readPublicFile("/og/Inter-Medium.ttf"),
    readPublicFile("/og/Inter-ExtraBold.ttf"),
    readPublicFile("/og/pr-logo.svg"),
    readPublicFile("/og/n8-icon.png"),
    p.listed ? loadProfileTier(url, null, p.hideGrade).catch(() => null) : null,
    heroShot(url).catch(() => null),
  ]);
  const letter = t?.shown ? tierLabel(t.shown) : null;
  const family = t?.shown ? (familyOf(t.shown) ?? "C") : null;
  const name = p.name;
  const tagline = p.tagline ? `${p.tagline} · ${p.domain}` : `Developer portfolio · ${p.domain}`;

  const card = shareCard({
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
    tagline: tagline.length > 70 ? `${tagline.slice(0, 68)}…` : tagline,
    visual: (
      <div style={{ display: "flex", position: "absolute", left: 628, top: 120, width: 640, height: 430 }}>
        {shot ? (
          // eslint-disable-next-line @next/next/no-img-element -- rendered by Satori, not the browser
          <img
            src={dataUrl(shot.buffer.slice(shot.byteOffset, shot.byteOffset + shot.byteLength) as ArrayBuffer, "image/jpeg")}
            width={640}
            height={400}
            alt=""
            style={{ borderRadius: 18, border: "1.5px solid #26262b", boxShadow: "0 30px 70px rgba(0,0,0,0.55)", objectFit: "cover", objectPosition: "top" }}
          />
        ) : (
          <div style={{ display: "flex", width: 640, height: 400, borderRadius: 18, border: "1.5px solid #26262b", background: "#121215" }} />
        )}
        {letter && family && (
          <div
            style={{
              display: "flex",
              position: "absolute",
              left: -36,
              bottom: 0,
              width: 132,
              height: 132,
              borderRadius: 30,
              alignItems: "center",
              justifyContent: "center",
              fontSize: letter.length > 2 ? 46 : letter.length > 1 ? 62 : 76,
              fontWeight: 800,
              background: TIER_BG[family] ?? TIER_BG.C,
              color: TIER_INK[family] ?? TIER_INK.C,
              border: `3px solid ${family === "S" ? "#0a0a0b" : amber}`,
              boxShadow: "0 18px 40px rgba(0,0,0,0.5)",
            }}
          >
            {letter}
          </div>
        )}
      </div>
    ),
  });
  const headers = new Headers(card.headers);
  headers.set("cache-control", "public, max-age=3600");
  headers.set("x-robots-tag", "noindex");
  return new Response(card.body, { status: 200, headers });
}
