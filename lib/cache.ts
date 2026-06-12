import fs from "fs/promises";
import path from "path";

// v0 file cache (local dev). Becomes a Supabase table when deployed —
// Vercel's filesystem is read-only.
export async function cached<T>(
  file: string,
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
  shouldCache: (data: T) => boolean = () => true
): Promise<T> {
  const filePath = path.join(process.cwd(), "data", file);
  let store: Record<string, { at: number; data: T }> = {};
  try {
    store = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {}

  const hit = store[key];
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;

  const data = await compute();
  if (shouldCache(data)) {
    store[key] = { at: Date.now(), data };
    await fs.writeFile(filePath, JSON.stringify(store));
  }
  return data;
}
