import test from "node:test";
import assert from "node:assert/strict";
import { FakeStorageArea, makeFakeChrome } from "./fake-chrome.mjs";
import { loadBundle, page, randomText } from "./helpers.mjs";

// 3.1.4's lock missed setState's quota-trim path: a state write under
// pressure could clobber a concurrent enqueue's queue write. With the single
// storage mutex, interleaved mutations must never lose a capture or a patch.

test("concurrent enqueue vs state-patch-under-pressure loses nothing", async () => {
  const fake = new FakeStorageArea({ quotaBytes: 250_000, accounting: "utf8" });
  // Add write latency so unserialized RMWs would actually interleave.
  const origSet = fake.set.bind(fake);
  fake.set = async (obj) => {
    await new Promise((r) => setTimeout(r, 3 + Math.random() * 10));
    return origSet(obj);
  };
  const storage = await loadBundle("storage", "chrome", makeFakeChrome(fake));

  // Fill near the quota so the state patch takes the trim-retry path.
  for (let i = 0; i < 25; i++) await storage.enqueue([{ ...page(i), text: randomText(9_000) }]);

  const results = await Promise.all([
    storage.applyStatePatch({ token: "fresh-token", lastSync: 42 }),
    storage.enqueue([{ ...page(900), text: "captured mid-patch" }]),
    storage.enqueue([{ ...page(901), text: "also mid-patch" }]),
    storage.applyStatePatch({ captureEnabled: false }),
  ]);
  assert.ok(results);

  const finalState = fake.snapshot()["wtm:state"];
  assert.equal(finalState.token, "fresh-token", "first patch survived");
  assert.equal(finalState.captureEnabled, false, "second patch survived");
  assert.equal(finalState.lastSync, 42, "patches merged, not clobbered");

  const q = await storage.getQueue();
  const ids = new Set(q.map((p) => p.id));
  assert.ok(ids.has("page-900") && ids.has("page-901"), "captures racing the patch were not lost");
});

test("mutations serialize strictly in call order", async () => {
  const fake = new FakeStorageArea();
  const storage = await loadBundle("storage", "chrome", makeFakeChrome(fake));
  const order = [];
  await Promise.all([
    storage.enqueue([page(1)]).then(() => order.push("a")),
    storage.applyStatePatch({ lastSync: 1 }).then(() => order.push("b")),
    storage.enqueue([page(2)]).then(() => order.push("c")),
    storage.clearQueue().then(() => order.push("d")),
  ]);
  assert.deepEqual(order, ["a", "b", "c", "d"]);
  assert.equal(await storage.getQueueCount(), 0, "clear ran last");
});
