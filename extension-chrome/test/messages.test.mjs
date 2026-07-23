import test from "node:test";
import assert from "node:assert/strict";
import { FakeStorageArea, makeFakeChrome } from "./fake-chrome.mjs";
import { loadBundle, makeFetch, page } from "./helpers.mjs";

const AUTH = { "wtm:state": { token: "tok", baseUrl: "https://api.test", user: { id: "u1", email: "u@x" }, captureEnabled: true } };

async function boot(fake, routes = {}) {
  const chromeObj = makeFakeChrome(fake);
  await loadBundle("background", "chrome", chromeObj, { fetchImpl: makeFetch(routes) });
  return { send: (msg) => chromeObj.runtime.sendMessage(msg), chromeObj };
}

test("setState message mutates and returns the new state", async () => {
  const fake = new FakeStorageArea();
  const { send } = await boot(fake);
  const resp = await send({ type: "setState", patch: { token: "t1", captureEnabled: false } });
  assert.equal(resp.ok, true);
  assert.equal(resp.state.token, "t1");
  assert.equal(resp.state.captureEnabled, false);
  assert.equal(fake.snapshot()["wtm:state"].token, "t1");
});

test("login-under-pressure: setState succeeds on a full device by trimming the queue", async () => {
  // Queue occupies nearly the whole quota; a state write must still land.
  const bigQueue = Array.from({ length: 30 }, (_, i) => page(i, 8_000));
  const fake = new FakeStorageArea({ quotaBytes: 60_000, accounting: "utf8", doubleCountOnRewrite: true });
  // Seed via a real write path so the stored format matches production.
  const { send } = await boot(fake);
  for (const p of bigQueue) await send({ type: "capture", page: p });
  const resp = await send({ type: "setState", patch: { token: "fresh-login-token" } });
  assert.equal(resp.ok, true, `state write failed: ${resp.error}`);
  assert.equal(fake.snapshot()["wtm:state"].token, "fresh-login-token");
});

test("clearQueue message permanently removes the local retry buffer", async () => {
  const fake = new FakeStorageArea({ seed: AUTH });
  const { send } = await boot(fake);
  for (let i = 0; i < 5; i++) await send({ type: "capture", page: page(i) });
  const resp = await send({ type: "clearQueue" });
  assert.equal(resp.ok, true);
  assert.equal((fake.snapshot()["wtm:queue"] ?? undefined), undefined, "queue key removed");
});
