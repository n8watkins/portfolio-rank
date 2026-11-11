import { OG_SIZE, dataUrl, shareCard } from "@/lib/og-card";
import { readPublicFile } from "@/lib/publicFile";
import { db, ensureSchema } from "@/lib/db";
import { JOB_ID, readJob } from "@/lib/grader/jobs.mjs";
import { graderEnabled, readGradeShot } from "@/lib/grader/server";

// A grade report's share card: the site, its tier and "top N%", beside its
// own screenshot. Like the report it is reached only through the report's
// id; a missing, deleted or unfinished report gets a plain card that names
// nothing. Like every report answer it is never kept in a shared cache, so
// a deleted report's card goes with it.

export const alt = "A PortfolioRank grade report";
export const size = OG_SIZE;
export const contentType = "image/png";

const amber = "#fbbf24";
const TIER_BG: Record<string, string> = { S: amber, A: "#3a2a0a", B: "#1c1c21", C: "#1c1c21", D: "#1c1c21" };
const TIER_INK: Record<string, string> = { S: "#0a0a0b", A: amber, B: "#ededf0", C: "#ededf0", D: "#8b8b93" };

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

async function report(id: string) {
  if (!graderEnabled() || !JOB_ID.test(id)) return null;
  await ensureSchema();
  const job = await readJob(db(), id);
  if (!job || job.status !== "done" || !job.result?.tier) return null;
  const shot = job.shot_key ? await readGradeShot(String(job.shot_key), "hero.jpg").catch(() => null) : null;
  const pct = job.report?.percentile ?? null;
  return { domain: domainOf(String(job.url)), tier: String(job.result.tier), pct: pct as { topPct: number; total: number } | null, shot };
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [medium, extraBold, mark, n8, r] = await Promise.all([
    readPublicFile("/og/Inter-Medium.ttf"),
    readPublicFile("/og/Inter-ExtraBold.ttf"),
    readPublicFile("/og/pr-logo.svg"),
    readPublicFile("/og/n8-icon.png"),
    report(id),
  ]);

  const name = r ? r.domain : "Grade report";
  const tagline = r
    ? r.pct
      ? `Tier ${r.tier}, top ${r.pct.topPct}% of ${r.pct.total.toLocaleString("en-US")} graded developer portfolios.`
      : `Tier ${r.tier} on PortfolioRank's grade for developer portfolios.`
    : "How good is your portfolio? A grade, your rank and what to fix first.";

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
    host: "portfoliorank.n8builds.dev",
    name,
    nameSize: name.length > 22 ? 46 : name.length > 14 ? 58 : 72,
    nameTracking: -1.6,
    tagline,
    visual: (
      <div style={{ display: "flex", position: "absolute", left: 628, top: 120, width: 640, height: 430 }}>
        {r?.shot ? (
          <img
            src={dataUrl(r.shot.buffer.slice(r.shot.byteOffset, r.shot.byteOffset + r.shot.byteLength) as ArrayBuffer, "image/jpeg")}
            width={640}
            height={400}
            alt=""
            style={{ borderRadius: 18, border: "1.5px solid #26262b", boxShadow: "0 30px 70px rgba(0,0,0,0.55)", objectFit: "cover", objectPosition: "top" }}
          />
        ) : (
          <div style={{ display: "flex", width: 640, height: 400, borderRadius: 18, border: "1.5px solid #26262b", background: "#121215" }} />
        )}
        {r && (
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
              fontSize: 76,
              fontWeight: 800,
              background: TIER_BG[r.tier] ?? TIER_BG.C,
              color: TIER_INK[r.tier] ?? TIER_INK.C,
              border: `3px solid ${r.tier === "S" ? "#0a0a0b" : amber}`,
              boxShadow: "0 18px 40px rgba(0,0,0,0.5)",
            }}
          >
            {r.tier}
          </div>
        )}
      </div>
    ),
  });
  const headers = new Headers(card.headers);
  headers.set("cache-control", "private, max-age=300");
  headers.set("x-robots-tag", "noindex");
  return new Response(card.body, { status: 200, headers });
}
