import test from "node:test";
import assert from "node:assert/strict";
import { FakeStorageArea, makeFakeChrome } from "./fake-chrome.mjs";
import { loadBundle, makeFetch, page } from "./helpers.mjs";

const state = (over = {}) => ({
  "wtm:state": { token: "tok", baseUrl: "https://api.test", user: { id: "u1", email: "u@x" }, captureEnabled: true, ...over },
});

function routes(registered) {
  return {
    "POST /nodes": (call) => {
      registered.push(call.body.id);
      return { id: call.body.id, name: call.body.name, platform: call.body.platform };
    },
    "POST /sync/push": (call) => ({ accepted: call.body.pages.length, deleted: 0, seq: 1 }),
  };
}

async function boot(fake, r) {
  const chromeObj = makeFakeChrome(fake);
  await loadBundle("background", "chrome", chromeObj, { fetchImpl: makeFetch(r) });
  return (msg) => chromeObj.runtime.sendMessage(msg);
}

test("node id is client-generated, registered once, persisted, reused across restarts", async () => {
  const registered = [];
  const fake = new FakeStorageArea({ seed: state() });
  const send = await boot(fake, routes(registered));
  await send({ type: "capture", page: page(1) });
  await send({ type: "flushNow" });
  assert.equal(registered.length, 1, "registered exactly once");
  const st = fake.snapshot()["wtm:state"];
  assert.equal(st.deviceId, registered[0], "client-supplied id persisted");
  assert.equal(st.deviceOwner, "https://api.test|u1");

  // "iOS kills the worker": fresh module instance over surviving storage.
  const send2 = await boot(fake, routes(registered));
  await send2({ type: "capture", page: page(2) });
  await send2({ type: "flushNow" });
  assert.equal(registered.length, 1, "restart reuses the persisted node id — no duplicate registration");
});

test("same account re-login reuses the node; different account regenerates", async () => {
  const registered = [];
  const fake = new FakeStorageArea({ seed: state({ deviceId: "node-orig", deviceOwner: "https://api.test|u1" }) });
  const send = await boot(fake, routes(registered));

  // Same owner: no registration call at all.
  await send({ type: "capture", page: page(1) });
  await send({ type: "flushNow" });
  assert.equal(registered.length, 0, "existing owned node reused silently");

  // Different account logs in: flush must mint a fresh id (a supplied id
  // owned by another user would 409 server-side).
  await send({ type: "setState", patch: { user: { id: "u2", email: "b@x" }, token: "tok2" } });
  await send({ type: "capture", page: page(2) });
  await send({ type: "flushNow" });
  assert.equal(registered.length, 1, "new account registered a fresh node");
  assert.notEqual(registered[0], "node-orig");
  assert.equal(fake.snapshot()["wtm:state"].deviceOwner, "https://api.test|u2");
});

test("registration failure surfaces as lastError and retries next run", async () => {
  const registered = [];
  const fake = new FakeStorageArea({ seed: state() });
  let fail = true;
  const send = await boot(fake, {
    "POST /nodes": (call) => {
      if (fail) return { status: 409, json: { error: "node_id_taken", message: "That device id is unavailable." } };
      registered.push(call.body.id);
      return { id: call.body.id, name: call.body.name, platform: call.body.platform };
    },
    "POST /sync/push": (call) => ({ accepted: call.body.pages.length, deleted: 0, seq: 1 }),
  });
  await send({ type: "capture", page: page(1) });
  await send({ type: "flushNow" });
  assert.match(fake.snapshot()["wtm:state"].lastError, /409/);
  fail = false;
  await send({ type: "flushNow" });
  assert.equal(registered.length, 1, "recovered on the next run");
  assert.equal(fake.snapshot()["wtm:state"].lastError, null);
});
