import { OG_SIZE, WindowShot, dataUrl, shareCard } from "@/lib/og-card";
import { readPublicFile } from "@/lib/publicFile";
import { leaderboard, report, siteBySlug, topPct } from "@/lib/preview/data";

// Share card for a grade report: the site's own screenshot, its tier and percentile.
export const alt = "A PortfolioRank grade report";
export const size = OG_SIZE;
export const contentType = "image/png";

const amber = "#fbbf24";

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const site = siteBySlug((await params).id);
  const [medium, extraBold, mark, n8, fallback] = await Promise.all([
    readPublicFile("/og/Inter-Medium.ttf"),
    readPublicFile("/og/Inter-ExtraBold.ttf"),
    readPublicFile("/og/pr-logo.svg"),
    readPublicFile("/og/n8-icon.png"),
    readPublicFile("/og/leaderboard.jpg"),
  ]);
  let shot = dataUrl(fallback, "image/jpeg");
  let line = "A PortfolioRank grade report";
  if (site) {
    try {
      const res = await fetch(`${site.shot}/hero.jpg`);
      if (res.ok) shot = dataUrl(await res.arrayBuffer(), "image/jpeg");
    } catch {}
    const rep = report(site);
    const board = leaderboard("merged");
    const r = board.find((x) => x.url === site.url);
    line = `Tier ${rep.grade.tier} · top ${r ? topPct(r.rank, board.length) : rep.est.topPct}% of ${board.length} graded portfolios`;
  }
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
    host: site ? site.domain : "portfoliorank.n8builds.dev",
    name: <div style={{ display: "flex" }}>{site?.name ?? "PortfolioRank"}</div>,
    nameSize: 60,
    tagline: line,
    visual: <WindowShot src={shot} surface="#070709" line="#232328" shadow="0 30px 70px rgba(0,0,0,0.55)" />,
  });
}
