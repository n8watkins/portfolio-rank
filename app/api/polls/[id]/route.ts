import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { cachedResponse } from "@/lib/edge-cache";
import { readPoll } from "@/lib/polls/store.mjs";
import { POLL_ID, publicPolls, type StoredPoll } from "@/lib/polls/server";
import { SITE_URL } from "@/lib/site";

// GET /api/polls/<id> -> { poll } for one poll that has opened (active or
// closed), for a shareable poll page; 404 for an unknown, upcoming or
// withdrawn one. Cached at the edge for a minute, like GET /api/polls.
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!POLL_ID.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return cachedResponse(`${SITE_URL}/api/polls/${id}`, async () => {
    await ensureSchema();
    const stored = (await readPoll(db(), id)) as StoredPoll | null;
    if (!stored) return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "public, max-age=60" } });
    const [poll] = await publicPolls([stored]);
    return NextResponse.json({ poll }, { headers: { "cache-control": "public, max-age=60" } });
  });
}
