// Unit tests for the queue behind the "Deleted · Undo" toasts (lib/undo-queue.ts).
// Node strips the TypeScript types itself, so the module is imported as is.
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createUndoQueue, UNDO_TOAST_MS } from "../lib/undo-queue.ts";

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"] }));
afterEach(() => mock.timers.reset());

const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(options = {}) {
  let toasts = [];
  const undoErrors = [];
  const queue = createUndoQueue({ onChange: (next) => (toasts = next), onUndoError: (entry) => undoErrors.push(entry.id), ...options });
  return { queue, toasts: () => toasts, undoErrors };
}

function spy() {
  const fn = () => { fn.calls += 1; };
  fn.calls = 0;
  return fn;
}

test("an action commits once its toast times out", async () => {
  const { queue, toasts } = setup();
  const commit = spy();
  const undo = spy();
  queue.push({ id: "a", message: "List deleted", undo, commit });
  assert.deepEqual(toasts(), [{ id: "a", message: "List deleted" }]);
  mock.timers.tick(UNDO_TOAST_MS - 1);
  await settle();
  assert.equal(commit.calls, 0);
  mock.timers.tick(1);
  await settle();
  assert.equal(commit.calls, 1);
  assert.equal(undo.calls, 0);
  assert.deepEqual(toasts(), []);
});

test("undo restores and never commits", async () => {
  const { queue } = setup();
  const commit = spy();
  const undo = spy();
  queue.push({ id: "a", message: "x", undo, commit });
  assert.equal(await queue.undo("a"), true);
  mock.timers.tick(UNDO_TOAST_MS * 2);
  await settle();
  assert.equal(undo.calls, 1);
  assert.equal(commit.calls, 0);
  assert.equal(await queue.undo("a"), false);
});

test("undo without an id targets the newest toast (Ctrl+Z)", async () => {
  const { queue } = setup();
  const first = spy();
  const second = spy();
  queue.push({ id: "a", message: "a", undo: first });
  queue.push({ id: "b", message: "b", undo: second });
  await queue.undo();
  assert.equal(second.calls, 1);
  assert.equal(first.calls, 0);
  assert.equal(queue.size, 1);
});

test("a failed undo is reported and the action does not commit later", async () => {
  const { queue, undoErrors } = setup();
  const commit = spy();
  queue.push({ id: "a", message: "a", undo: () => Promise.reject(new Error("gone")), commit });
  assert.equal(await queue.undo("a"), false);
  assert.deepEqual(undoErrors, ["a"]);
  mock.timers.tick(UNDO_TOAST_MS);
  await settle();
  assert.equal(commit.calls, 0);
});

test("pause stops the countdown and resume continues it", async () => {
  const { queue } = setup();
  const commit = spy();
  queue.push({ id: "a", message: "a", undo: spy(), commit });
  mock.timers.tick(4_000);
  queue.pause();
  mock.timers.tick(60_000);
  await settle();
  assert.equal(commit.calls, 0);
  queue.resume();
  mock.timers.tick(UNDO_TOAST_MS - 4_000);
  await settle();
  assert.equal(commit.calls, 1);
});

test("the stack stays short: the oldest toast commits when it overflows", async () => {
  const { queue, toasts } = setup({ maxVisible: 2 });
  const commits = [];
  for (const id of ["a", "b", "c"]) queue.push({ id, message: id, undo: spy(), commit: () => commits.push(id) });
  await settle();
  assert.deepEqual(toasts().map((t) => t.id), ["b", "c"]);
  assert.deepEqual(commits, ["a"]);
});

test("flush commits everything, as when the page is hidden", async () => {
  const { queue, toasts } = setup();
  const commits = [];
  for (const id of ["a", "b"]) queue.push({ id, message: id, undo: spy(), commit: () => commits.push(id) });
  queue.flush();
  await settle();
  assert.deepEqual(commits, ["a", "b"]);
  assert.deepEqual(toasts(), []);
});
