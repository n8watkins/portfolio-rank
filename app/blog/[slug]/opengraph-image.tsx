import { OG_SIZE, WindowShot, dataUrl, shareCard } from "@/lib/og-card";
import { readPublicFile } from "@/lib/publicFile";
import { publishedPost } from "@/lib/blog-server";
import { coverOf } from "@/lib/blog";
import { readMedia } from "@/lib/blog-media";

// A post's share card: the site's card with the post's title and dek, and
// its cover on the right when the cover is a photo, an illustration or a
// screenshot (charts are SVG with text, which the card renderer can't draw
// without the fonts, so a chart cover falls back to the site's picture).
export const alt = "A PortfolioRank blog post";
export const size = OG_SIZE;
export const contentType = "image/png";
export const revalidate = 300;

const amber = "#fbbf24";

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await publishedPost(slug);
  const [medium, extraBold, mark, n8, fallback] = await Promise.all([
    readPublicFile("/og/Inter-Medium.ttf"),
    readPublicFile("/og/Inter-ExtraBold.ttf"),
    readPublicFile("/og/pr-logo.svg"),
    readPublicFile("/og/n8-icon.png"),
    readPublicFile("/og/leaderboard.jpg"),
  ]);
  const cover = post ? coverOf(post.images) : null;
  const coverBytes = cover?.key && /\.jpe?g$/i.test(cover.key) ? await readMedia(cover.key).catch(() => null) : null;
  const title = post?.title ?? "PortfolioRank blog";
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
    host: "portfoliorank.n8builds.dev/blog",
    name: <div style={{ display: "flex" }}>{title}</div>,
    nameSize: title.length > 60 ? 40 : title.length > 36 ? 46 : 56,
    nameTracking: -1,
    tagline: post?.subtitle ?? "What the best developer portfolios do, from PortfolioRank's own data.",
    visual: (
      <WindowShot
        src={coverBytes ? dataUrl(coverBytes.buffer as ArrayBuffer, "image/jpeg") : dataUrl(fallback, "image/jpeg")}
        surface="#0a0a0b"
        line="#26262b"
        shadow="0 30px 70px rgba(0,0,0,0.55)"
      />
    ),
  });
}
