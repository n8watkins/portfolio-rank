import type { MetadataRoute } from "next";

// Web app manifest: installable now, and the base for the Play Store app
// (a Trusted Web Activity wraps this PWA). Icons come from public/pr-logo.svg.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "PortfolioRank",
    short_name: "PortfolioRank",
    description: "How good is your portfolio? Grade it, see where you rank, and vote in face-offs.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#09090b",
    theme_color: "#09090b",
    categories: ["productivity", "developer", "education"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Grade a portfolio", url: "/#grade" },
      { name: "Leaderboard", url: "/top" },
      { name: "Face-off", url: "/rank" },
    ],
  };
}
