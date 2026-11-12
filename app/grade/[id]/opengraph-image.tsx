import { ImageResponse } from "next/og";
import { OG_SIZE } from "@/lib/og-card";
import { readPublicFile } from "@/lib/publicFile";
import { db, ensureSchema } from "@/lib/db";
import { JOB_ID, readJob } from "@/lib/grader/jobs.mjs";
import { displayName } from "@/lib/grader/present.mjs";
import { graderEnabled } from "@/lib/grader/server";
import { listedSite } from "@/lib/me";
import { SITE_URL } from "@/lib/site";

// A grade report's share card: an ad for the person, not for PortfolioRank.
// Their name, their portfolio's address and the result are the whole card;
// PortfolioRank is one small, quiet address in the corner (owner, 2026-11-12).
// Long names and addresses shrink to fit, then end in an ellipsis; nothing
// overflows. Like the report it is reached only through the report's id; a
// missing, deleted or unfinished report gets a plain card that names nothing.
// Like every report answer it is never kept in a shared cache, so a deleted
// report's card goes with it.

export const alt = "A PortfolioRank grade report";
export const size = OG_SIZE;
export const contentType = "image/png";

const W = OG_SIZE.width;
const PAD = 80;
const TEXT_W = W - 2 * PAD;
const BG = "#0b0b0d";
const INK = "#f4f4f6";
const MUTED = "#8b8b93";
const AMBER = "#fbbf24";
const TIER_BG: Record<string, string> = { S: AMBER, A: "#3a2a0a", B: "#1c1c21", C: "#1c1c21", D: "#1c1c21" };
const TIER_INK: Record<string, string> = { S: "#0a0a0b", A: AMBER, B: "#ededf0", C: "#ededf0", D: "#a1a1aa" };

/**
 * The biggest size (between min and max) at which `text` fits `width` on one
 * line, from an estimate of Inter's average glyph width; the card adds an
 * ellipsis as a backstop when even the minimum is too wide.
 */
function fitSize(text: string, width: number, { max, min, em }: { max: number; min: number; em: number }): number {
  const fit = Math.floor(width / Math.max(1, text.length * em));
  return Math.max(min, Math.min(max, fit));
}

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** The address as people type it: no scheme, no trailing slash. */
const shownUrl = (url: string) => url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");

async function report(id: string) {
  if (!graderEnabled() || !JOB_ID.test(id)) return null;
  await ensureSchema();
  const job = await readJob(db(), id);
  if (!job || job.status !== "done" || !job.result?.tier) return null;
  const url = String(job.url);
  const domain = domainOf(url);
  const quick = job.quick as { title?: string } | null;
  const name = displayName({ listedName: listedSite(String(job.site_key))?.name, title: quick?.title, domain });
  const pct = (job.report?.percentile ?? null) as { topPct: number; total: number } | null;
  return { name, url: shownUrl(url), tier: String(job.result.tier), pct };
}

const oneLine = { display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: TEXT_W } as const;

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [medium, extraBold, r] = await Promise.all([readPublicFile("/og/Inter-Medium.ttf"), readPublicFile("/og/Inter-ExtraBold.ttf"), report(id)]);
  const host = (process.env.AUTH_URL || SITE_URL).replace(/^https?:\/\//, "").replace(/\/$/, "");

  const name = r?.name ?? "Grade report";
  const nameSize = fitSize(name, TEXT_W, { max: 112, min: 56, em: 0.6 });
  const url = r?.url ?? "How good is your portfolio?";
  const urlSize = fitSize(url, TEXT_W, { max: 40, min: 26, em: 0.56 });

  const card = new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          padding: PAD,
          background: BG,
          backgroundImage: "radial-gradient(circle at 92% 8%, rgba(251,191,36,0.16), rgba(11,11,13,0) 46%)",
          fontFamily: "Inter",
          color: INK,
        }}
      >
        <div style={{ ...oneLine, fontSize: nameSize, fontWeight: 800, lineHeight: 1.08, letterSpacing: -0.025 * nameSize }}>{name}</div>
        {url !== name && <div style={{ ...oneLine, marginTop: 14, fontSize: urlSize, fontWeight: 500, color: MUTED }}>{url}</div>}

        {r && (
          <div style={{ display: "flex", alignItems: "center", gap: 36, marginTop: "auto" }}>
            <div
              style={{
                display: "flex",
                flexShrink: 0,
                width: 156,
                height: 156,
                borderRadius: 34,
                alignItems: "center",
                justifyContent: "center",
                fontSize: 96,
                fontWeight: 800,
                background: TIER_BG[r.tier] ?? TIER_BG.C,
                color: TIER_INK[r.tier] ?? TIER_INK.C,
                border: `3px solid ${r.tier === "S" ? BG : AMBER}`,
              }}
            >
              {r.tier}
            </div>
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <div style={{ display: "flex", fontSize: r.pct ? 112 : 96, fontWeight: 800, lineHeight: 1, letterSpacing: -3 }}>{r.pct ? `Top ${r.pct.topPct}%` : `Tier ${r.tier}`}</div>
              {r.pct && (
                <div style={{ display: "flex", marginTop: 14, fontSize: 30, fontWeight: 500, color: MUTED }}>
                  {`of ${r.pct.total.toLocaleString("en-US")} graded developer portfolios`}
                </div>
              )}
            </div>
          </div>
        )}

        <div style={{ display: "flex", position: "absolute", right: PAD, bottom: 36, fontSize: 22, fontWeight: 500, color: "#5f5f68" }}>{host}</div>
      </div>
    ),
    {
      ...OG_SIZE,
      fonts: [
        { name: "Inter", data: medium, weight: 500, style: "normal" },
        { name: "Inter", data: extraBold, weight: 800, style: "normal" },
      ],
    }
  );
  const headers = new Headers(card.headers);
  headers.set("cache-control", "private, max-age=300");
  headers.set("x-robots-tag", "noindex");
  return new Response(card.body, { status: 200, headers });
}
