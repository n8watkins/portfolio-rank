// Checks, with one real PageSpeed key, what the two-runs-a-device measure
// assumes (lib/psi-runs.mjs, lib/psi-pacing.mjs): two runs of one URL, N
// seconds apart, and whether they are two different Lighthouse runs.
// Prints each run's `fetchTime` (Lighthouse's own time stamp: equal means the
// same run came back twice), the performance score and how long the call took.
//
//   pass-env run -- node scripts/experiments/psi-two-runs.mjs <url> [gapSeconds=30] [mobile|desktop]
//
// Needs PSI_API_KEY in the environment; it makes exactly 2 PageSpeed calls and
// stops without a key. Run it before the first release that measures with two
// runs, with gaps of 0 and 30 for example, and read the verdict lines.
const [url, gapArg = "30", strategy = "mobile"] = process.argv.slice(2);
const key = process.env.PSI_API_KEY;
if (!key || !url) {
  console.error("usage: PSI_API_KEY=... node scripts/experiments/psi-two-runs.mjs <url> [gapSeconds=30] [mobile|desktop]\nNo key or no url: nothing was called.");
  process.exit(2);
}
const gap = Number(gapArg);
if (!Number.isFinite(gap) || gap < 0) {
  console.error("gapSeconds must be a number of 0 or more");
  process.exit(2);
}

async function run(n) {
  const api = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  api.searchParams.set("url", url);
  api.searchParams.set("strategy", strategy);
  api.searchParams.set("key", key);
  api.searchParams.append("category", "performance");
  const started = Date.now();
  const res = await fetch(api, { signal: AbortSignal.timeout(120_000) });
  const seconds = (Date.now() - started) / 1000;
  const body = await res.json().catch(() => ({}));
  const lhr = body.lighthouseResult;
  const out = {
    run: n,
    status: res.status,
    seconds: Number(seconds.toFixed(1)),
    fetchTime: lhr?.fetchTime ?? null,
    performance: typeof lhr?.categories?.performance?.score === "number" ? Math.round(lhr.categories.performance.score * 100) : null,
  };
  if (!res.ok) out.error = String(body?.error?.message ?? "").slice(0, 200);
  console.log(JSON.stringify(out));
  return out;
}

const a = await run(1);
if (gap > 0) await new Promise((r) => setTimeout(r, gap * 1000));
const b = await run(2);
console.log(`gap ${gap} s between the calls (started when the first one finished)`);
if (a.fetchTime && b.fetchTime) console.log(a.fetchTime === b.fetchTime ? "SAME run came back twice: the second is not a new measurement at this gap." : "two different runs.");
else console.log("could not compare: a call failed.");
