import fs from "node:fs";
import crypto from "node:crypto";

export const UA = "PortfolioRank-research/1.0";

/** Short stable file key for a URL. */
export const keyOf = (url) => crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);

/** Rows of "url|final_url|name". */
export function readSample(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [url, finalUrl, ...rest] = line.split("|");
      return { url: url.trim(), finalUrl: finalUrl.trim() || null, name: rest.join("|").trim() || null };
    });
}

/** Runs fn over items with at most n in flight. */
export async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const item = items[i++];
        try {
          await fn(item);
        } catch (e) {
          console.error("fail", item?.url ?? item, e?.message ?? e);
        }
      }
    })
  );
}
