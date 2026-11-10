// Lint: Next.js's recommended rules (React, hooks, Core Web Vitals) plus its
// TypeScript rules. `npm run lint`; CI runs it on every pull request.
import { createRequire } from "node:module";
import Module from "node:module";
import { defineConfig, globalIgnores } from "eslint/config";

// typescript-eslint reads TypeScript through the JS compiler API, which
// TypeScript 7 (the native compiler this project builds with) no longer
// ships. TypeScript's own side-by-side package carries the 6.x API, so the
// lint toolchain (packages in node_modules asking for `typescript` while
// ESLint runs) is pointed there. Remove this once
// typescript-eslint supports TS 7 (typescript-eslint/typescript-eslint#10940).
const require = createRequire(import.meta.url);
const ts6 = require.resolve("@typescript/typescript6");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "typescript" && /[\\/]node_modules[\\/]/.test(parent?.filename ?? "")) {
    return ts6;
  }
  return resolve.call(this, request, parent, ...rest);
};

const { default: nextVitals } = await import("eslint-config-next/core-web-vitals");
const { default: nextTs } = await import("eslint-config-next/typescript");

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    ".open-next/**",
    ".wrangler/**",
    "node_modules/**",
    "next-env.d.ts",
    "cloudflare-env.d.ts",
  ]),
]);
