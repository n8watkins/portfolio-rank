#!/usr/bin/env node
// Runs the tests that need no running site: every tests/*.test.mjs that reads
// none of scripts/test-e2e.sh's E2E_ variables (scripts/ci-lanes.mjs
// unitTests). No build, no server, no database: about a minute and a half.
// npm run test:e2e runs every test, these included, unless it is told to run
// only the ones that need the site (E2E_TESTS=site, as CI does, where this
// runner has the rest).
//
//   npm run test:unit                    all of them
//   npm run test:unit -- --list          print the unit test files and stop
//   npm run test:unit -- --list-site     print the files that need the site
import { spawnSync } from "node:child_process";
import { siteTests, unitTests } from "./ci-lanes.mjs";

/**
 * A test never reaches a real service, even when the shell has the keys (under
 * pass-env, say). The same variables scripts/test-e2e.sh clears, and the other
 * keys this project uses.
 */
const REAL_SERVICE = [
  /^TURSO_/, /^R2_/, /^KIT_/, /^SENTRY_/, /^CLOUDFLARE_/, /^STAGING_/,
  /^(GEMINI_API_KEY|PSI_API_KEY|TURNSTILE_SECRET_KEY|SEND_EMAIL|SHOTS_BASE_URL)$/,
  /^(GITHUB_API_TOKEN|GITHUB_DISPATCH_TOKEN|GH_SYNC_TOKEN|TAVILY_API_KEY|PEXELS_API_KEY|AUTH_SECRET)$/,
];

const root = process.cwd();
if (process.argv.includes("--list-site")) {
  console.log(siteTests(root).join("\n"));
  process.exit(0);
}
const files = unitTests(root);
if (process.argv.includes("--list")) {
  console.log(files.join("\n"));
  process.exit(0);
}
if (!files.length) {
  console.error("test-unit: no test files found; run it from the repository root.");
  process.exit(1);
}
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !REAL_SERVICE.some((re) => re.test(name))));
// Files run side by side: none of them shares a server or a database, which
// is what makes the site tests run one at a time.
const run = spawnSync(process.execPath, ["--test", "--test-timeout=120000", ...files], { stdio: "inherit", env });
process.exit(run.status ?? 1);
