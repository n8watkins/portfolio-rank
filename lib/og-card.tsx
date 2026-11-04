import { ImageResponse } from "next/og";
import type { CSSProperties, ReactNode } from "react";

/**
 * The n8builds share card (Open Graph and Twitter, 1200x630). Every app uses
 * the same grid in its own colors, logo and typeface: logo and address top
 * left, then the name, a one-line tagline and the n8builds.dev mark, with one
 * picture of the product on the right that runs off the edges. The mark sits
 * under the tagline because X draws its domain label in the bottom-left corner.
 *
 * Keep box-shadow blur at 70px or less: larger blurs on big boxes crash resvg.
 */

export const OG_SIZE = { width: 1200, height: 630 };

export const dataUrl = (bytes: ArrayBuffer, type: string) =>
  `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;

export type ShareFont = { name: string; data: ArrayBuffer; weight: 500 | 700 | 800 };

export type ShareCardProps = {
  colors: { bg: string; bgImage?: string; ink: string; muted: string; body: string; accent: string };
  /** Body face; `headFont` (if set) is used for the name. */
  font: string;
  headFont?: string;
  fonts: ShareFont[];
  /** Data URLs. */
  logo: string;
  n8Icon: string;
  logoStyle?: CSSProperties;
  host: string;
  name: ReactNode;
  nameSize?: number;
  nameTracking?: number;
  tagline: ReactNode;
  /** Absolutely positioned on the right half (x 628 to 1200). */
  visual: ReactNode;
};

export function shareCard(p: ShareCardProps) {
  const { colors: c } = p;
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          position: "relative",
          width: "100%",
          height: "100%",
          overflow: "hidden",
          background: c.bg,
          backgroundImage: c.bgImage,
          fontFamily: p.font,
          color: c.ink,
        }}
      >
        {p.visual}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            position: "absolute",
            left: 72,
            top: 72,
            bottom: 64,
            width: 500,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- rendered by Satori, not the browser */}
            <img src={p.logo} width={60} height={60} alt="" style={{ borderRadius: 14, ...p.logoStyle }} />
            <div
              style={{
                display: "flex",
                fontSize: p.host.length > 30 ? 19 : 24,
                fontWeight: 500,
                color: c.muted,
                whiteSpace: "nowrap",
              }}
            >
              {p.host}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: "auto", marginBottom: "auto" }}>
            <div
              style={{
                display: "flex",
                fontSize: p.nameSize ?? 76,
                fontWeight: 800,
                lineHeight: 1.04,
                letterSpacing: p.nameTracking ?? -2.2,
                fontFamily: p.headFont ?? p.font,
                flexWrap: "wrap",
              }}
            >
              {p.name}
            </div>
            <div
              style={{
                display: "flex",
                marginTop: 24,
                fontSize: 31,
                fontWeight: 500,
                lineHeight: 1.36,
                color: c.body,
                maxWidth: 500,
              }}
            >
              {p.tagline}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 34 }}>
              <div style={{ width: 32, height: 4, borderRadius: 4, background: c.accent }} />
              {/* eslint-disable-next-line @next/next/no-img-element -- rendered by Satori, not the browser */}
              <img src={p.n8Icon} width={30} height={30} alt="" style={{ borderRadius: 7 }} />
              <div style={{ display: "flex", fontSize: 22, fontWeight: 500, color: c.muted }}>n8builds.dev</div>
            </div>
          </div>
          <div style={{ display: "flex", height: 40 }} />
        </div>
      </div>
    ),
    { ...OG_SIZE, fonts: p.fonts.map((f) => ({ ...f, style: "normal" as const })) },
  );
}

/** A screenshot in a window frame that runs off the right and bottom edges. */
export function WindowShot({ src, surface, line, shadow }: { src: string; surface: string; line: string; shadow: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        position: "absolute",
        left: 628,
        top: 84,
        width: 640,
        height: 620,
        borderRadius: 20,
        overflow: "hidden",
        background: surface,
        border: `1.5px solid ${line}`,
        boxShadow: shadow,
      }}
    >
      <div
        style={{
          display: "flex",
          height: 36,
          alignItems: "center",
          gap: 8,
          paddingLeft: 16,
          borderBottom: `1px solid ${line}`,
        }}
      >
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ width: 11, height: 11, borderRadius: 11, background: line }} />
        ))}
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element -- rendered by Satori, not the browser */}
      <img src={src} width={640} height={600} alt="" />
    </div>
  );
}

/** A phone screenshot that runs off the bottom edge. */
export function PhoneShot({
  src,
  width,
  height,
  bezel,
  shadow,
}: {
  src: string;
  /** Source pixel size, for the aspect ratio. */
  width: number;
  height: number;
  bezel: string;
  shadow: string;
}) {
  const w = 330;
  const h = Math.round((height * w) / width);
  return (
    <div
      style={{
        display: "flex",
        position: "absolute",
        left: 742,
        top: 64,
        width: w + 20,
        height: h + 20,
        padding: 10,
        borderRadius: 52,
        background: bezel,
        boxShadow: shadow,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- rendered by Satori, not the browser */}
      <img src={src} width={w} height={h} alt="" style={{ borderRadius: 42 }} />
    </div>
  );
}
