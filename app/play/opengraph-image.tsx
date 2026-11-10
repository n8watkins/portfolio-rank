import { OG_SIZE, WindowShot, dataUrl, shareCard } from "@/lib/og-card";
import { readPublicFile } from "@/lib/publicFile";

// Share card for Play links, including quiz challenges.
export const alt = "Guess the percentile on PortfolioRank";
export const size = OG_SIZE;
export const contentType = "image/png";

const amber = "#fbbf24";

export default async function Image() {
  const [medium, extraBold, mark, n8, shot] = await Promise.all([
    readPublicFile("/og/Inter-Medium.ttf"),
    readPublicFile("/og/Inter-ExtraBold.ttf"),
    readPublicFile("/og/pr-logo.svg"),
    readPublicFile("/og/n8-icon.png"),
    readPublicFile("/og/leaderboard.jpg"),
  ]);
  return shareCard({
    colors: {
      bg: "#070709",
      bgImage: "radial-gradient(circle at 80% 40%, rgba(251,191,36,0.16), rgba(7,7,9,0) 55%)",
      ink: "#ececef",
      muted: "#8d8d96",
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
    name: (
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span>Can you beat</span>
        <span style={{ color: amber }}>4 of 5?</span>
      </div>
    ),
    nameSize: 58,
    tagline: "Guess where five developer portfolios land. A new Daily 5 every day.",
    visual: <WindowShot src={dataUrl(shot, "image/jpeg")} surface="#070709" line="#232328" shadow="0 30px 70px rgba(0,0,0,0.55)" />,
  });
}
