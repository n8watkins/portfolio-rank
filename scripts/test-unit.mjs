#!/usr/bin/env node
// Runs the tests that need no running site: every tests/*.test.mjs that reads
// none of scripts/test-e2e.sh's E2E_ variables (scripts/ci-lanes.mjs
// unitTests). No build, no server, no database: about a minute and a half.
// npm run test:e2e still runs every test, these included.
//
//   npm run test:unit                 all of them
//   npm run test:unit -- --list       print the files and stop
import { spawnSync } from "node:child_process";
import { unitTests } from "./ci-lanes.mjs";

const files = unitTests(process.cwd());
if (process.argv.includes("--list")) {
  console.log(files.join("\n"));
  process.exit(0);
}
if (!files.length) {
  console.error("test-unit: no test files found; run it from the repository root.");
  process.exit(1);
}
// A unit test must never reach a real database.
const env = { ...process.env };
delete env.TURSO_DATABASE_URL;
delete env.TURSO_AUTH_TOKEN;
const run = spawnSync(process.execPath, ["--test", "--test-timeout=120000", ...files], { stdio: "inherit", env });
process.exit(run.status ?? 1);
