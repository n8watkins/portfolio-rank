import { ImageResponse } from "next/og";
import { OG_SIZE, dataUrl } from "@/lib/og-card";
import { readPublicFile } from "@/lib/publicFile";
import { SITE_URL } from "@/lib/site";
import { fitName, fitSize, friendlyCount } from "@/lib/og-fit.mjs";
import { TierChip } from "@/lib/og-tier";

/**
 * The share card of one portfolio (1200x630), shared by a grade report
 * (app/grade/[id]/opengraph-image.tsx) and a listed portfolio's page
 * (app/og/p/[...slug]/route.tsx), so both look alike. It is an ad for the
 * person (owner, 2026-11-12): their name and address top left, their own
 * screenshot large on the right with the tier letter on its corner, the
 * result framed against the whole library ("Top 13% of 1,300+ portfolios")
 * and PortfolioRank small, bottom right.
 *
 * When the name is the address itself, the address line is left out.
 * A long name wraps to two lines, then shrinks, then loses middle or
 * trailing words (lib/og-fit.mjs fitName), never cut mid-word; a long
 * address shrinks, then ends in one; without a screenshot the frame shows the
 * address instead; without a result the left side keeps only the name.
 * Keep box-shadow blur at 70px or less: larger blurs on big boxes crash resvg.
 */
export type PortfolioCardInput = {
  /** The person's name, else the site's own name (lib/grader/present.mjs displayName). */
  name: string;
  /** The address as people type it: no scheme, no trailing slash. */
  url: string;
  /** The hero screenshot (JPEG), or null. */
  shot: Uint8Array | null;
  /** A public tier by rank (lib/tiers.mjs, SSS to B), or null to show none. */
  tier: string | null;
  /** "Top N%" and the number of portfolios it is among, or null to show no result. */
  result: { topPct: number; total: number } | null;
  /** The address shown small, bottom right: always the public site's (owner, 2026-11-12), also on staging and locally. */
  host?: string;
};

const BG = "#0a0a0b";
const INK = "#ededf0";
const MUTED = "#8b8b93";
const AMBER = "#fbbf24";

const LEFT = 72;
const COL_W = 500;
const SHOT = { left: 628, top: 104, width: 640, height: 400 };

export async function portfolioCard(c: PortfolioCardInput, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const [medium, extraBold, mark] = await Promise.all([readPublicFile("/og/Inter-Medium.ttf"), readPublicFile("/og/Inter-ExtraBold.ttf"), readPublicFile("/og/pr-logo.svg")]);

  const name = fitName(c.name, COL_W);
  const urlSize = fitSize(c.url, COL_W, { max: 30, min: 20, em: 0.55 });
  const shot = c.shot ? dataUrl(c.shot.buffer.slice(c.shot.byteOffset, c.shot.byteOffset + c.shot.byteLength) as ArrayBuffer, "image/jpeg") : null;

  const card = new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          position: "relative",
          width: "100%",
          height: "100%",
          overflow: "hidden",
          background: BG,
          // Depth: a warm amber glow behind the screenshot, a fainter one low
          // on the left under the result, and a slight lift from the top.
          backgroundImage:
            "radial-gradient(ellipse 760px 560px at 76% 50%, rgba(251,191,36,0.30), rgba(251,191,36,0.10) 40%, rgba(10,10,11,0) 72%), radial-gradient(ellipse 560px 380px at 6% 104%, rgba(245,158,11,0.18), rgba(10,10,11,0) 70%), linear-gradient(180deg, #121215 0%, #0a0a0b 65%)",
          fontFamily: "Inter",
          color: INK,
        }}
      >
        {/* A faint amber grid behind the screenshot, fading out at its edges */}
        <div
          style={{
            display: "flex",
            position: "absolute",
            left: SHOT.left - 90,
            top: SHOT.top - 80,
            width: SHOT.width + 180,
            height: SHOT.height + 170,
            backgroundImage:
              "repeating-linear-gradient(0deg, rgba(251,191,36,0.10) 0px, rgba(251,191,36,0.10) 1px, rgba(0,0,0,0) 1px, rgba(0,0,0,0) 32px), repeating-linear-gradient(90deg, rgba(251,191,36,0.10) 0px, rgba(251,191,36,0.10) 1px, rgba(0,0,0,0) 1px, rgba(0,0,0,0) 32px)",
            maskImage: "radial-gradient(ellipse at center, rgba(0,0,0,1) 30%, rgba(0,0,0,0) 72%)",
          }}
        />
        {/* The screenshot, with the tier on its corner */}
        <div style={{ display: "flex", position: "absolute", left: SHOT.left, top: SHOT.top, width: SHOT.width, height: SHOT.height + 30 }}>
          {shot ? (
            // eslint-disable-next-line @next/next/no-img-element -- rendered by Satori, not the browser
            <img
              src={shot}
              width={SHOT.width}
              height={SHOT.height}
              alt=""
              style={{ borderRadius: 18, border: "1.5px solid #26262b", boxShadow: "0 30px 70px rgba(0,0,0,0.55)", objectFit: "cover", objectPosition: "top" }}
            />
          ) : (
            <div
              style={{
                display: "flex",
                width: SHOT.width,
                height: SHOT.height,
                borderRadius: 18,
                border: "1.5px solid #26262b",
                background: "#121215",
                alignItems: "center",
                justifyContent: "center",
                padding: 40,
                fontSize: 34,
                fontWeight: 500,
                color: "#5f5f68",
              }}
            >
              <div style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: SHOT.width - 80 }}>{c.url}</div>
            </div>
          )}
          {c.tier && (
            <TierChip tier={c.tier} style={{ position: "absolute", left: -36, bottom: 0 }} />
          )}
        </div>

        {/* Who: name and address */}
        <div style={{ display: "flex", flexDirection: "column", position: "absolute", left: LEFT, top: 76, width: COL_W }}>
          <div style={{ display: "flex", flexDirection: "column", fontSize: name.size, fontWeight: 800, lineHeight: 1.06, letterSpacing: -0.025 * name.size }}>
            {name.lines.map((line, i) => (
              <div key={i} style={{ display: "flex", whiteSpace: "nowrap" }}>
                {line}
              </div>
            ))}
          </div>
          {c.url !== c.name && <div style={{ display: "block", marginTop: 14, fontSize: urlSize, fontWeight: 500, color: AMBER, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.url}</div>}
        </div>

        {/* The result, against the whole library */}
        {c.result && (
          <div style={{ display: "flex", flexDirection: "column", position: "absolute", left: LEFT, bottom: 112, width: COL_W - 40 }}>
            <div style={{ display: "flex", fontSize: 92, fontWeight: 800, lineHeight: 1, letterSpacing: -3 }}>{`Top ${c.result.topPct}%`}</div>
            <div style={{ display: "flex", marginTop: 12, fontSize: 30, fontWeight: 500, color: MUTED }}>{`of ${friendlyCount(c.result.total)} portfolios`}</div>
          </div>
        )}

        {/* PortfolioRank, small */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, position: "absolute", right: 64, bottom: 40 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- rendered by Satori, not the browser */}
          <img src={dataUrl(mark, "image/svg+xml")} width={36} height={36} alt="" style={{ borderRadius: 9 }} />
          <div style={{ display: "flex", fontSize: 22, fontWeight: 500, color: "#a1a1aa" }}>{c.host ?? new URL(SITE_URL).host}</div>
        </div>
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
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  return new Response(card.body, { status: 200, headers });
}
