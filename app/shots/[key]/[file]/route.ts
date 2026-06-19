import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";

export const runtime = "nodejs";

// Serves our local Playwright captures (captures/<shot_key>/<file>) so dev can
// show real screenshots without R2. In prod SHOTS_BASE_URL points at the public
// R2 bucket instead, so this route isn't used (and captures/ isn't deployed).
// Locked down: shot_key must be 16 hex chars and the file must be allowlisted,
// so no path traversal or arbitrary file reads are possible.
const CAPTURES = path.join(process.cwd(), "captures");
const ALLOWED = new Set([
  "hero.jpg",
  "mobile.jpg",
  "full.jpg",
  "strip0.png",
  "strip1.png",
  "strip2.png",
]);
const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".png": "image/png" };

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string; file: string }> }
) {
  const { key, file } = await params;
  if (!/^[0-9a-f]{16}$/.test(key) || !ALLOWED.has(file)) {
    return new NextResponse("not found", { status: 404 });
  }
  const filePath = path.join(CAPTURES, key, file);
  // Defense in depth: the validated inputs already preclude traversal, but
  // confirm the resolved path stays inside captures/ before reading.
  if (!filePath.startsWith(CAPTURES + path.sep)) {
    return new NextResponse("not found", { status: 404 });
  }
  try {
    const buf = await readFile(filePath);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    return new NextResponse("not found", { status: 404 });
  }
}
