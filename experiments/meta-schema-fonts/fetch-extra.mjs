// Step 1b: robots.txt, the sitemap and (only when the page names no icon)
// /favicon.ico, one small request each, at the origin the home page landed on.
//
//   node experiments/meta-schema-fonts/fetch-extra.mjs <sample.psv> <rawDir>
//
// Reads <rawDir>/fetch.json and the raw HTML; writes <rawDir>/extra.json.
import fs from "node:fs";
import path from "node:path";
import { keyOf, pool, readSample, UA } from "./common.mjs";

const [samplePath, rawDir] = process.argv.slice(2);
const fetched = JSON.parse(fs.readFileSync(path.join(rawDir, "fetch.json"), "utf8"));

async function get(url, accept) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept }, redirect: "follow", signal: ctl.signal });
    const buf = Buffer.from(await res.arrayBuffer()).subarray(0, 300_000);
    return { status: res.status, finalUrl: res.url, type: res.headers.get("content-type") ?? "", body: buf };
  } catch (e) {
    return { error: String(e?.cause?.code ?? e?.name ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Groups of robots.txt rules that apply to every crawler ("User-agent: *"). */
function blocksAll(txt) {
  let inStar = false,
    lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, k, v] = m;
    if (/^user-agent$/i.test(k)) {
      inStar = lastWasAgent ? inStar || v.trim() === "*" : v.trim() === "*";
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (inStar && /^disallow$/i.test(k) && v.trim() === "/") return true;
  }
  return false;
}

const isHtml = (r) => /text\/html/i.test(r.type ?? "") || /^\s*<(!doctype|html)/i.test(r.body?.subarray(0, 200).toString() ?? "");

const out = {};
await pool(readSample(samplePath), 4, async ({ url }) => {
  const f = fetched[url];
  const origin = new URL(f?.finalUrl ?? url).origin;
  const row = { origin };
  const rb = await get(`${origin}/robots.txt`, "text/plain,*/*");
  const robotsOk = rb.status === 200 && !isHtml(rb);
  const robotsTxt = robotsOk ? rb.body.toString("utf8") : "";
  row.robots = {
    status: rb.status ?? rb.error,
    exists: robotsOk,
    // A 200 that is really the app's HTML page (single-page-app fallback) is not a robots.txt.
    htmlFallback: rb.status === 200 && isHtml(rb),
    blocksAll: robotsOk && blocksAll(robotsTxt),
    sitemaps: [...robotsTxt.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]),
  };
  const smUrl = row.robots.sitemaps[0] ?? `${origin}/sitemap.xml`;
  const sm = await get(smUrl, "application/xml,text/xml,*/*");
  const smText = sm.body?.toString("utf8") ?? "";
  row.sitemap = {
    url: smUrl,
    fromRobots: !!row.robots.sitemaps[0],
    status: sm.status ?? sm.error,
    valid: sm.status === 200 && /<(urlset|sitemapindex)\b/i.test(smText),
    htmlFallback: sm.status === 200 && isHtml(sm),
    urls: (smText.match(/<loc>/gi) ?? []).length,
  };
  const html = fs.existsSync(path.join(rawDir, `${keyOf(url)}.html`)) ? fs.readFileSync(path.join(rawDir, `${keyOf(url)}.html`), "utf8") : "";
  if (!/<link\b[^>]*\brel\s*=\s*["']?[^"'>]*\bicon\b/i.test(html)) {
    const fi = await get(`${origin}/favicon.ico`, "image/*,*/*");
    row.faviconIco = { status: fi.status ?? fi.error, loads: fi.status === 200 && !isHtml(fi) && (fi.body?.length ?? 0) > 0 };
  }
  out[url] = row;
  console.log(url, row.robots.exists ? (row.robots.blocksAll ? "robots BLOCKS ALL" : "robots ok") : "no robots", row.sitemap.valid ? "sitemap ok" : "no sitemap", row.faviconIco ? `ico ${row.faviconIco.loads}` : "");
});
fs.writeFileSync(path.join(rawDir, "extra.json"), JSON.stringify(out, null, 1));
