// Checks that the bundled Worker exports every class wrangler.jsonc binds
// (Durable Objects and Workflows). CI runs it on the dry-run bundle:
//   npx wrangler deploy --dry-run --outdir DIR && node scripts/check-worker-exports.mjs DIR/index.js
//
// Why: `opennextjs-cloudflare deploy` prints "A DurableObjectNamespace in the
// config referenced the class DOQueueHandler, but no such Durable Object
// class is exported from the worker". That line comes from the local
// Miniflare proxy OpenNext starts with wrangler's getPlatformProxy() only to
// read the config's string variables; the proxy runs no Worker code, so it
// never has the class. The uploaded Worker does export it (worker/index.ts
// re-exports OpenNext's DOQueueHandler, which the ISR revalidation queue in
// open-next.config.ts uses). This check makes that a fact CI proves on every
// change, so the warning can be ignored safely and a real missing export
// fails the PR instead of the ISR queue at runtime (DEPLOY.md).
import { readFileSync } from "node:fs";

/** wrangler.jsonc without comments (strings, which hold "//" in URLs, are kept). */
export function parseJsonc(text) {
  return JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? ""));
}

/** The class names the config binds: Durable Objects and Workflows. */
export function boundClasses(config) {
  const durable = (config.durable_objects?.bindings ?? []).filter((b) => !b.script_name).map((b) => b.class_name);
  const workflows = (config.workflows ?? []).filter((w) => !w.script_name).map((w) => w.class_name);
  return [...new Set([...durable, ...workflows])];
}

/** The names in the bundle's final `export { a, b as c, ... }`. */
export function exportedNames(bundle) {
  const blocks = [...bundle.matchAll(/^export\s*\{([^}]*)\}\s*;?\s*$/gm)];
  const names = new Set();
  for (const [, list] of blocks) {
    for (const item of list.split(",")) {
      const parts = item.trim().split(/\s+as\s+/);
      const name = (parts[1] ?? parts[0]).trim();
      if (name) names.add(name);
    }
  }
  for (const [, name] of bundle.matchAll(/^export\s+(?:class|const|function)\s+([A-Za-z_$][\w$]*)/gm)) names.add(name);
  return names;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bundlePath = process.argv[2];
  if (!bundlePath) {
    console.error("usage: node scripts/check-worker-exports.mjs <bundle index.js> [wrangler.jsonc]");
    process.exit(1);
  }
  const config = parseJsonc(readFileSync(process.argv[3] ?? "wrangler.jsonc", "utf8"));
  const exported = exportedNames(readFileSync(bundlePath, "utf8"));
  const missing = boundClasses(config).filter((c) => !exported.has(c));
  if (missing.length) {
    console.error(`::error::the Worker bundle does not export ${missing.join(", ")}, which wrangler.jsonc binds`);
    process.exit(1);
  }
  console.log(`the Worker exports every bound class: ${boundClasses(config).join(", ")}`);
}
