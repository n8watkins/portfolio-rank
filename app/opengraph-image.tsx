import { OG_SIZE, WindowShot, dataUrl, shareCard } from "@/lib/og-card";
import { readPublicFile } from "@/lib/publicFile";

// The share card (Open Graph and Twitter): the n8builds family layout in
// PortfolioRank's black and amber, with the home page leaderboard on the right.

export const alt = "PortfolioRank: 1,700+ developer portfolios in one place. Browse, compare and vote for the best.";
export const size = OG_SIZE;
export const contentType = "image/png";

const amber = "#fbbf24";

export default async function Image() {
  // Inter (OFL, public/og/Inter-LICENSE.txt), the marks and the screenshot, from public/.
  const [medium, extraBold, mark, n8, shot] = await Promise.all([
    readPublicFile("/og/Inter-Medium.ttf"),
    readPublicFile("/og/Inter-ExtraBold.ttf"),
    readPublicFile("/og/pr-logo.svg"),
    readPublicFile("/og/n8-icon.png"),
    readPublicFile("/og/leaderboard.jpg"),
  ]);

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
    host: "portfoliorank.n8builds.dev",
    name: (
      <div style={{ display: "flex" }}>
        <span>Portfolio</span>
        <span style={{ color: amber }}>Rank</span>
      </div>
    ),
    nameSize: 66,
    tagline: "1,700+ developer portfolios in one place. Browse, compare and vote for the best.",
    visual: (
      <WindowShot
        src={dataUrl(shot, "image/jpeg")}
        surface="#0a0a0b"
        line="#26262b"
        shadow="0 30px 70px rgba(0,0,0,0.55)"
      />
    ),
  });
}
