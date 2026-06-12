import { db, ensureSchema } from "./db";

export async function cached<T>(
  namespace: string,
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
  shouldCache: (data: T) => boolean = () => true
): Promise<T> {
  await ensureSchema();
  const k = `${namespace}:${key}`;

  const row = (
    await db().execute({ sql: "SELECT v, at FROM cache WHERE k = ?", args: [k] })
  ).rows[0];
  if (row && Date.now() - Number(row.at) < ttlMs) {
    return JSON.parse(String(row.v)) as T;
  }

  const data = await compute();
  if (shouldCache(data)) {
    await db().execute({
      sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, ?, ?)",
      args: [k, JSON.stringify(data), Date.now()],
    });
  }
  return data;
}
