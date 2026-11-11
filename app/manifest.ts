import type { MetadataRoute } from "next";
import { ROUTES } from "@/lib/nav";

// Web app manifest: installable, with icons drawn from public/pr-logo.svg.
export default function manifest(): MetadataRoute.Manifest {
  const shortcuts = [
    { name: "Grade a portfolio", url: ROUTES.grade },
    { name: "Leaderboard", url: ROUTES.top },
    { name: "Face-off", url: ROUTES.faceoff },
  ].filter((s): s is { name: string; url: string } => s.url !== null);
  return {
    id: "/",
    name: "PortfolioRank",
    short_name: "PortfolioRank",
    description: "The best developer portfolios, ranked by people and AI. Vote in face-offs and see who's on top.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#070709",
    theme_color: "#070709",
    categories: ["productivity", "developer", "education"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts,
  };
}
