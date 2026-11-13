// Opens the staging site in the owner's Windows browser through its gate link
// (worker/staging-gate.ts), without printing the key:
//   pass-env run -e STAGING_GATE_KEY=portfolio-rank/STAGING_GATE_KEY -- node scripts/open-staging.mjs
// The cookie it sets lasts 30 days.
import { spawnSync } from "node:child_process";

const key = process.env.STAGING_GATE_KEY;
if (!key) {
  console.error("STAGING_GATE_KEY is not set; run this through pass-env (see the comment at the top).");
  process.exit(1);
}
const url = `https://staging.portfoliorank.dev/__gate?key=${encodeURIComponent(key)}`;
// cmd.exe treats & % ^ specially; the key is URL-encoded, so only % could appear.
const result = spawnSync("cmd.exe", ["/c", "start", "", url.replace(/%/g, "^%")], { stdio: "ignore" });
if (result.error || result.status !== 0) {
  console.error("Could not start the browser through cmd.exe.");
  process.exit(1);
}
console.log("Opened the staging gate link in your browser.");
