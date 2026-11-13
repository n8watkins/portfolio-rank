// Step 1: fetch each home page once (plain HTTP, no JavaScript), plus its
// og:image, and keep the raw bytes outside the repo.
//
//   node experiments/meta-schema-fonts/fetch.mjs <sample.psv> <rawDir>
//
// sample.psv: one "url|final_url|name" per line (from the read-only sample
// query in README.md). Writes <rawDir>/<key>.html and <rawDir>/fetch.json.
import fs from "node:fs";
import path from "node:path";
import { keyOf, pool, readSample, UA } from "./common.mjs";

const [samplePath, rawDir] = process.argv.slice(2);
if (!samplePath || !rawDir) throw new Error("usage: fetch.mjs <sample.psv> <rawDir>");
fs.mkdirSync(rawDir, { recursive: true });

const MAX_BYTES = 3_000_000;

async function get(url, { accept = "text/html,*/*" } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept }, redirect: "follow", signal: ctl.signal });
    const chunks = [];
    let n = 0;
    for await (const c of res.body ?? []) {
      chunks.push(c);
      n += c.length;
      if (n > MAX_BYTES) break;
    }
    ctl.abort();
    return { status: res.status, finalUrl: res.url, type: res.headers.get("content-type") ?? "", body: Buffer.concat(chunks), bytes: n };
  } catch (e) {
    return { error: String(e?.cause?.code ?? e?.name ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/** First og:image (or twitter:image) in the raw HTML, resolved against the page. Regex is enough for this one tag. */
function imageUrl(html, base) {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  const want = ["og:image", "og:image:url", "og:image:secure_url", "twitter:image"];
  for (const name of want) {
    for (const t of tags) {
      const key = t.match(/\b(?:property|name)\s*=\s*["']?([^"'\s>]+)/i)?.[1]?.toLowerCase();
      const content = t.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      if (key === name && content) {
        const v = (content[1] ?? content[2] ?? content[3] ?? "").trim();
        try {
          return new URL(v, base).href;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function isImage(buf, type) {
  if (/^image\//i.test(type)) return true;
  const b = buf.subarray(0, 12);
  return (
    (b[0] === 0xff && b[1] === 0xd8) || // jpeg
    b.toString("ascii", 1, 4) === "PNG" ||
    b.toString("ascii", 0, 3) === "GIF" ||
    (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") ||
    /<svg/i.test(buf.subarray(0, 300).toString())
  );
}

const sample = readSample(samplePath);
const out = {};
await pool(sample, 4, async ({ url }) => {
  const key = keyOf(url);
  const r = await get(url);
  const row = { url, status: r.status ?? null, error: r.error ?? null, finalUrl: r.finalUrl ?? null, type: r.type ?? null, bytes: r.bytes ?? 0 };
  if (r.body) {
    fs.writeFileSync(path.join(rawDir, `${key}.html`), r.body);
    const img = imageUrl(r.body.toString("utf8"), r.finalUrl);
    if (img) {
      const ir = await get(img, { accept: "image/*,*/*" });
      row.ogImage = {
        url: img,
        status: ir.status ?? null,
        error: ir.error ?? null,
        type: ir.type ?? null,
        bytes: ir.bytes ?? 0,
        loads: !!(ir.status && ir.status < 400 && ir.body?.length && isImage(ir.body, ir.type)),
      };
    }
  }
  out[url] = row;
  console.log(`${row.status ?? row.error} ${url}${row.ogImage ? ` og:image ${row.ogImage.loads ? "ok" : "BROKEN"}` : ""}`);
});
fs.writeFileSync(path.join(rawDir, "fetch.json"), JSON.stringify(out, null, 1));
