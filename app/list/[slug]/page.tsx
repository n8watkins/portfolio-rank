import type { Metadata } from "next";
import { notFound } from "next/navigation";
import feed from "@/data/feed.json";
import type { Portfolio } from "@/app/page";
import { auth } from "@/auth";
import { db, ensureSchema } from "@/lib/db";
import { heroOf, mshotsUrl, shotBases } from "@/lib/shots";
import { ListView, type ListItem } from "@/components/ListView";

export const dynamic = "force-dynamic";

const SITE_URL = "https://portfoliorank.vercel.app";

const byUrl = new Map((feed as Portfolio[]).map((p) => [p.url, p]));

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

type LoadedList = {
  id: number;
  name: string;
  slug: string;
  isPublic: boolean;
  isOwner: boolean;
  items: ListItem[];
};

// Resolve a list for viewing. A private list is only visible to its owner;
// anyone else (and any missing slug) gets null → 404, which also keeps a
// private list's existence from leaking.
async function loadList(slug: string): Promise<LoadedList | null> {
  await ensureSchema();
  const row = (
    await db().execute({
      sql: "SELECT id, owner, name, slug, is_public FROM lists WHERE slug = ?",
      args: [slug],
    })
  ).rows[0];
  if (!row) return null;

  const session = await auth();
  const isOwner = !!session?.raterId && session.raterId === String(row.owner);
  const isPublic = Number(row.is_public) === 1;
  if (!isPublic && !isOwner) return null;

  const items: ListItem[] = (
    await db().execute({
      sql: "SELECT url FROM list_items WHERE list_id = ? ORDER BY added_at DESC",
      args: [Number(row.id)],
    })
  ).rows
    .map((r) => String(r.url))
    .filter((u) => byUrl.has(u))
    .map((u) => ({ url: u, name: byUrl.get(u)!.name, domain: domainOf(u) }));

  return {
    id: Number(row.id),
    name: String(row.name),
    slug: String(row.slug),
    isPublic,
    isOwner,
    items,
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const list = await loadList(slug);
  if (!list || !list.isPublic) return { title: "List — PortfolioRank" };

  const title = `${list.name} — a PortfolioRank list`;
  const description = `${list.items.length} developer portfolio${
    list.items.length === 1 ? "" : "s"
  }, collected on PortfolioRank.`;
  const canonical = `${SITE_URL}/list/${slug}`;

  // OG image: the first portfolio's hero, mirroring the detail page.
  let image: string | undefined;
  const first = list.items[0]?.url;
  if (first) {
    const base = (await shotBases([first])).get(first);
    image = base ? heroOf(base) : mshotsUrl(first, 1200);
  }

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      type: "website",
      images: image ? [{ url: image }] : undefined,
    },
    twitter: {
      card: image ? "summary_large_image" : "summary",
      title,
      description,
      images: image ? [image] : undefined,
    },
  };
}

export default async function ListPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const list = await loadList(slug);
  if (!list) notFound();

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6">
      <header className="flex items-center justify-between py-4">
        <a href="/" className="text-sm font-bold tracking-tight">
          ← Portfolio<span className="text-accent">Rank</span>
        </a>
        <a
          href="/top"
          className="text-xs font-semibold text-mute transition hover:text-ink"
        >
          🏆 Leaderboard
        </a>
      </header>

      <ListView
        listId={list.id}
        slug={list.slug}
        initialName={list.name}
        initialPublic={list.isPublic}
        isOwner={list.isOwner}
        items={list.items}
        shareUrl={`${SITE_URL}/list/${list.slug}`}
      />
    </div>
  );
}
