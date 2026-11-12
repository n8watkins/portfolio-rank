// scripts/check-worker-exports.mjs: the classes wrangler.jsonc binds, read
// from the real config, and the export list of a bundle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boundClasses, exportedNames, parseJsonc } from "../scripts/check-worker-exports.mjs";

test("wrangler.jsonc parses with its comments, and binds the ISR queue, the night Workflow and the draft Workflow", () => {
  const config = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
  assert.match(config.vars.SENTRY_DSN, /^https:\/\//, "a // inside a string is not a comment");
  assert.deepEqual(boundClasses(config).sort(), ["DOQueueHandler", "DraftWorkflow", "EndOfDayWorkflow"]);
  assert.deepEqual(boundClasses(config.env.staging).sort(), ["DOQueueHandler", "DraftWorkflow", "EndOfDayWorkflow"]);
});

test("worker/index.ts re-exports every bound class", () => {
  const src = readFileSync("worker/index.ts", "utf8");
  assert.match(src, /export \{ DOQueueHandler \} from "\.\.\/\.open-next\/worker\.js"/);
  assert.match(src, /export \{ EndOfDayWorkflow \} from "\.\/night"/);
  assert.match(src, /export \{ DraftWorkflow \} from "\.\/draft"/);
});

test("exportedNames reads an esbuild export list, renames included", () => {
  const bundle = "var x = 1;\nexport {\n  DOQueueHandler,\n  EndOfDayWorkflow,\n  index_default as default\n};\n";
  assert.deepEqual([...exportedNames(bundle)].sort(), ["DOQueueHandler", "EndOfDayWorkflow", "default"]);
  assert.equal(exportedNames("export {\n  index_default as default\n};\n").has("DOQueueHandler"), false);
});
