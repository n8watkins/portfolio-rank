import test from "node:test";
import assert from "node:assert/strict";
import { AI_GATEWAY_ID, AiBudgetExhausted, withGateway } from "../lib/ai-gateway.mjs";

test("no binding stays null", () => assert.equal(withGateway(undefined), null));

test("every run passes the gateway option and keeps other options", async () => {
  const calls = [];
  const ai = withGateway({ run: async (...a) => (calls.push(a), { image: "x" }) });
  assert.deepEqual(await ai.run("m", { prompt: "p" }), { image: "x" });
  await ai.run("m", { prompt: "p" }, { returnRawResponse: true });
  assert.deepEqual(calls[0][2], { gateway: { id: AI_GATEWAY_ID } });
  assert.deepEqual(calls[1][2], { returnRawResponse: true, gateway: { id: AI_GATEWAY_ID } });
  assert.equal(AI_GATEWAY_ID, "portfoliorank-ai");
});

test("a 429 from the gateway is budget exhausted, with no retry", async () => {
  let n = 0;
  const ai = withGateway({ run: async () => { n++; throw Object.assign(new Error("429 Too Many Requests"), { status: 429 }); } });
  await assert.rejects(() => ai.run("m", {}), (e) => e instanceof AiBudgetExhausted && e.status === 429);
  assert.equal(n, 1);
});

test("other errors pass through unchanged", async () => {
  const boom = new Error("model down");
  const ai = withGateway({ run: async () => { throw boom; } });
  await assert.rejects(() => ai.run("m", {}), (e) => e === boom);
});
