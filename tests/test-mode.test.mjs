// lib/test-mode.mjs: test stand-ins (the GRADER_TEST_* seams, the email
// outbox) are an allow-list. Only the test runs and `next dev` may use them;
// a Worker with no SITE_ENV, or a misspelled one, may not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testStandInsAllowed } from "../lib/test-mode.mjs";

test("the test runs and next dev may use test stand-ins", () => {
  assert.equal(testStandInsAllowed({ SITE_ENV: "test", NODE_ENV: "production" }), true);
  assert.equal(testStandInsAllowed({ NODE_ENV: "development" }), true);
});

test("everything else may not: production, staging, a missing or misspelled SITE_ENV", () => {
  for (const env of [
    { SITE_ENV: "production", NODE_ENV: "production" },
    { SITE_ENV: "staging", NODE_ENV: "production" },
    { NODE_ENV: "production" },
    { SITE_ENV: "Test", NODE_ENV: "production" },
    { SITE_ENV: "prod" },
    {},
    undefined,
  ]) {
    assert.equal(testStandInsAllowed(env), false, JSON.stringify(env));
  }
});

test("the email outbox leaves next dev out", () => {
  assert.equal(testStandInsAllowed({ NODE_ENV: "development" }, { dev: false }), false);
  assert.equal(testStandInsAllowed({ SITE_ENV: "test" }, { dev: false }), true);
});
