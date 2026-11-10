import { PlayPage } from "@/components/preview/PlayPage";
import { visitor } from "@/lib/preview/visitor";

export const dynamic = "force-dynamic";

// Face-off keeps its address; it is the first mode of /play.
export default async function RankPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const v = await visitor(await searchParams);
  return <PlayPage v={v} mode="faceoff" />;
}
