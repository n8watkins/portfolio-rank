import { AppShell } from "@/components/shell/AppShell";
import { FaceOff } from "@/components/preview/FaceOff";
import { SampleTag } from "@/components/preview/bits";
import { faceoffPairs } from "@/lib/preview/data";
import { visitor } from "@/lib/preview/visitor";

export const dynamic = "force-dynamic";

export default async function RankPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const v = await visitor(await searchParams);
  const pairs = faceoffPairs(12).map(
    (p) => p.map(({ name, domain, shot, tagline, slug }) => ({ name, domain, shot, tagline, slug })) as [typeof p[0], typeof p[1]]
  );
  return (
    <AppShell visitor={v} current="rank">
      <div className="mx-auto max-w-5xl py-4 sm:py-8">
        <div className="mb-3 flex items-center justify-between gap-3 sm:mb-5">
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Which one would you hire from?</h1>
          <SampleTag what="Vote shares" />
        </div>
        <FaceOff pairs={pairs} voted={v.voted} />
      </div>
    </AppShell>
  );
}
