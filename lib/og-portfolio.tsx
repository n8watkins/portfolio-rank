import { ImageResponse } from "next/og";
import { OG_SIZE, dataUrl } from "@/lib/og-card";
import { readPublicFile } from "@/lib/publicFile";

/**
 * The share card of one portfolio (1200x630), shared by a grade report
 * (app/grade/[id]/opengraph-image.tsx) and a listed portfolio's page
 * (app/p/[slug]/opengraph-image.tsx), so both look alike. It is an ad for the
 * person (owner, 2026-11-12): their name and address top left, their own
 * screenshot large on the right with the tier letter on its corner, the
 * result framed against the whole library ("Top 13% of 1,300+ portfolios")
 * and PortfolioRank small, bottom right.
 *
 * When the name is the address itself, the address line is left out.
 * Long names wrap to two lines and shrink, then end in an ellipsis; a long
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
  tier: string | null;
  /** "Top N%" and the number of portfolios it is among, or null to show no result. */
  result: { topPct: number; total: number } | null;
  /** The site the card links back to, shown small (the Worker's own address). */
  host: string;
};

const BG = "#0a0a0b";
const INK = "#ededf0";
const MUTED = "#8b8b93";
const AMBER = "#fbbf24";
const TIER_BG: Record<string, string> = { S: AMBER, A: "#3a2a0a", B: "#1c1c21", C: "#1c1c21", D: "#1c1c21" };
const TIER_INK: Record<string, string> = { S: "#0a0a0b", A: AMBER, B: "#ededf0", C: "#ededf0", D: "#a1a1aa" };

const LEFT = 72;
const COL_W = 500;
const SHOT = { left: 628, top: 104, width: 640, height: 400 };

/** A friendly lower bound for a count: 1,370 gives "1,300+", 2,046 gives "2,000+", 87 gives "80+". */
export function friendlyCount(n: number): string {
  const step = n >= 1000 ? 100 : n >= 100 ? 10 : 1;
  const down = Math.floor(n / step) * step;
  return `${down.toLocaleString("en-US")}${down < n ? "+" : ""}`;
}

/** The biggest font size (min..max) at which `text` fits `lines` lines of `width`, from Inter's average glyph width `em`. */
export function fitSize(text: string, width: number, { max, min, em, lines = 1 }: { max: number; min: number; em: number; lines?: number }): number {
  const fit = Math.floor((lines * width) / Math.max(1, text.length * em));
  return Math.max(min, Math.min(max, fit));
}

export async function portfolioCard(c: PortfolioCardInput, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const [medium, extraBold, mark] = await Promise.all([readPublicFile("/og/Inter-Medium.ttf"), readPublicFile("/og/Inter-ExtraBold.ttf"), readPublicFile("/og/pr-logo.svg")]);

  // One line when it fits at 56px or more, else up to two lines.
  const oneLine = fitSize(c.name, COL_W, { max: 72, min: 30, em: 0.6 });
  const nameLines = oneLine >= 56 ? 1 : 2;
  const nameSize = nameLines === 1 ? oneLine : fitSize(c.name, COL_W, { max: 56, min: 36, em: 0.6, lines: 2 });
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
          backgroundImage: "radial-gradient(circle at 80% 40%, rgba(251,191,36,0.14), rgba(10,10,11,0) 55%)",
          fontFamily: "Inter",
          color: INK,
        }}
      >
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
                background: TIER_BG[c.tier] ?? TIER_BG.C,
                color: TIER_INK[c.tier] ?? TIER_INK.C,
                border: `3px solid ${c.tier === "S" ? BG : AMBER}`,
                boxShadow: "0 18px 40px rgba(0,0,0,0.5)",
              }}
            >
              {c.tier}
            </div>
          )}
        </div>

        {/* Who: name and address */}
        <div style={{ display: "flex", flexDirection: "column", position: "absolute", left: LEFT, top: 76, width: COL_W }}>
          <div
            style={{
              display: "block",
              fontSize: nameSize,
              fontWeight: 800,
              lineHeight: 1.06,
              letterSpacing: -0.025 * nameSize,
              maxHeight: nameSize * 1.06 * nameLines + 4,
              overflow: "hidden",
              lineClamp: nameLines,
              ...(nameLines === 1 ? { whiteSpace: "nowrap", textOverflow: "ellipsis" } : {}),
            }}
          >
            {c.name}
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
          <div style={{ display: "flex", fontSize: 22, fontWeight: 500, color: "#a1a1aa" }}>{c.host}</div>
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
