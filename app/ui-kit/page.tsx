import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Inbox } from "lucide-react";
import { ChipLink, tag } from "@/components/ui/Chip";
import { CopyButton } from "@/components/ui/CopyButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Odometer } from "@/components/ui/Odometer";
import { ScreenshotFrame } from "@/components/ui/ScreenshotFrame";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Movement, RankBadge, TierBadge } from "@/components/ui/badges";
import { TIERS } from "@/lib/tiers.mjs";
import { btnGhost, btnPrimary, btnSecondary } from "@/components/ui/styles";
import { Showcase } from "@/components/home/Showcase";
import { KitSignup, KitIconButtons } from "./parts";

// Flat stand-in frames for the deck, so the browser tests need no captures.
const frame = (hue: number) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900"><rect width="1440" height="900" fill="hsl(${hue} 45% 45%)"/></svg>`)}`;
const DECK = ["Ada", "Grace", "Linus", "Margaret"].map((name, i) => ({
  url: `https://${name.toLowerCase()}.example/`,
  name,
  domain: `${name.toLowerCase()}.example`,
  hero: frame(30 + i * 70),
  tier: "A",
  rank: i + 1,
  href: `/p/${encodeURIComponent(`https://${name.toLowerCase()}.example/`)}`,
}));

// The shared building blocks on one page, for screenshots and the browser
// tests. Only in `next dev` and the test build (SITE_ENV=test); everywhere
// else it is a 404, so it never reaches visitors.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "UI kit - PortfolioRank", robots: { index: false, follow: false } };

export default async function UiKit({ searchParams }: { searchParams: Promise<{ tag?: string }> }) {
  if (process.env.NODE_ENV !== "development" && process.env.SITE_ENV !== "test") notFound();
  const sp = await searchParams;
  const tags = ["all", "build-in-public", "postmortem"];
  return (
    <div className="wrap py-10">
      <SectionHeader as="h1" eyebrow="Shared" title="UI kit" />

      <section aria-labelledby="kit-forms" className="grid gap-6 lg:grid-cols-2">
        <h2 id="kit-forms" className="sr-only">
          Forms
        </h2>
        <div className="card p-5 sm:p-6">
          <p className="mb-4 text-sm font-semibold">Email sign-up (wide)</p>
          <KitSignup />
        </div>
        <div className="max-w-xs">
          <div className="card p-5">
            <p className="mb-4 text-sm font-semibold">Email sign-up (sidebar)</p>
            <KitSignup />
          </div>
        </div>
      </section>

      <section aria-labelledby="kit-buttons" className="mt-12">
        <SectionHeader id="kit-buttons" title="Buttons" className="mb-4" />
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={btnPrimary}>
            Grade yours
          </button>
          <button type="button" className={btnSecondary}>
            Secondary
          </button>
          <button type="button" className={btnGhost}>
            Ghost
          </button>
          <button type="button" disabled className={btnPrimary}>
            Disabled
          </button>
          <KitIconButtons />
          <CopyButton text="https://portfoliorank.n8builds.dev" label="Copy link" />
        </div>
      </section>

      <section aria-labelledby="kit-chips" className="mt-12">
        <SectionHeader id="kit-chips" title="Chips and badges" className="mb-4" />
        <div className="flex flex-wrap items-center gap-2">
          {tags.map((t) => (
            <ChipLink key={t} href={t === "all" ? "/ui-kit" : `/ui-kit?tag=${t}`} current={(sp.tag ?? "all") === t}>
              {t}
            </ChipLink>
          ))}
          <span className={tag}>tag</span>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {TIERS.map((t) => (
            <TierBadge key={t} tier={t} />
          ))}
          <TierBadge tier="SSS" size="lg" />
          <TierBadge tier="S+" size="lg" />
          <TierBadge tier="S" size="lg" />
          <TierBadge tier="A-" size="lg" />
          <TierBadge tier="B+" size="lg" />
          <RankBadge rank={1} />
          <RankBadge rank={2} />
          <RankBadge rank={3} />
          <RankBadge rank={4} tied />
          <Movement move={3} />
          <Movement move={-2} />
          <Movement move={0} />
          <span className="text-3xl font-bold tabular-nums">
            <Odometer value="2,103" />
          </span>
        </div>
      </section>

      <section aria-labelledby="kit-frames" className="mt-12">
        <SectionHeader id="kit-frames" title="Screenshot frame and empty state" className="mb-4" />
        <div className="grid gap-4 sm:grid-cols-3">
          <ScreenshotFrame src={null} alt="No capture yet" domain="example.dev" className="card" />
          <ScreenshotFrame src="/zz-missing.jpg" alt="A capture that fails to load" domain="broken.example" className="card" />
          <ScreenshotFrame src="/icons/icon-512.png" alt="A low-quality capture" domain="lowq.example" quality={12} className="card" />
        </div>
        <EmptyState icon={Inbox} title="No lists yet" className="mt-4" action={<button type="button" className={btnSecondary}>New list</button>}>
          Lists you make show up here, with a link to share each one.
        </EmptyState>
      </section>

      <section aria-labelledby="kit-deck" className="mt-12 max-w-2xl">
        <SectionHeader id="kit-deck" title="Hero card deck" className="mb-4" />
        <Showcase items={DECK} />
      </section>
    </div>
  );
}
