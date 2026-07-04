import test from "node:test";
import assert from "node:assert/strict";
import { FakeStorageArea, makeFakeChrome, SimulatedKill } from "./fake-chrome.mjs";
import { loadBundle, page, randomText } from "./helpers.mjs";

// The wedge observed live: at the brim Safari double-counts old+new during a
// key rewrite, so EVERY set() fails (even shrinking/empty writes) and only
// remove() recovers. These tests seed that exact condition.

function wedgedFake(extra = {}) {
  // ~750KB UTF-16 quota holding a ~650KB (UTF-16) uncompressed plain-array
  // queue — the real 3.1.6 field state (748,161 bytes reported). Text is
  // repetitive like real page prose, so it compresses the way real pages do.
  const bigQueue = Array.from({ length: 50 }, (_, i) => page(i, 6_500));
  const fake = new FakeStorageArea({
    accounting: "utf16",
    doubleCountOnRewrite: true,
    seed: { "wtm:queue": bigQueue, "wtm:state": { token: "tok", captureEnabled: true } },
    ...extra,
  });
  // Park the quota just above current usage: the compressed rewrite (~5.6KB
  // for this seed) exceeds the 2KB headroom under double-counting, so
  // recovery REQUIRES the remove-then-set escape — the exact field condition.
  fake.quotaBytes = fake.usage() + 2_000;
  return fake;
}

test("upgrade path: wedged 3.1.x device self-heals on first enqueue", async () => {
  const fake = wedgedFake();
  const storage = await loadBundle("storage", "safari-ios", makeFakeChrome(fake));
  await storage.enqueue([page(999)]); // pre-fix this threw / silently trimmed forever
  const stored = fake.snapshot()["wtm:queue"];
  assert.equal(stored.v, 2, "queue re-encoded compressed");
  const diags = await storage.getStorageDiagnostics();
  assert.ok(diags.brimEscapes >= 1, "recovered via remove-then-set");
  assert.ok((await storage.getQueueCount()) >= 40, "backlog survives the migration (compressed fits)");
  assert.ok(fake.usage() < 400_000, "storage pressure actually relieved");
});

test("state writes work on a wedged device (login must not be broken)", async () => {
  const fake = wedgedFake();
  const storage = await loadBundle("storage", "safari-ios", makeFakeChrome(fake));
  const st = await storage.applyStatePatch({ token: "fresh-token" });
  assert.equal(st.token, "fresh-token");
  assert.equal(fake.snapshot()["wtm:state"].token, "fresh-token", "state persisted despite the brim");
});

test("pessimistic: remove() failing degrades to trim (capture never throws) while writes still fit", async () => {
  const fake = wedgedFake({ removeFails: true });
  const storage = await loadBundle("storage", "safari-ios", makeFakeChrome(fake));
  // Old queue can't be freed (remove fails) and any sizable rewrite double-
  // counts over quota — the trim loop shrinks until the payload squeezes into
  // the remaining headroom. Lossy, but capture must not throw.
  await storage.enqueue([page(999)]);
  assert.ok((await storage.getQueueCount()) >= 0, "no throw; queue in a consistent state");
});

test("hard wedge (zero headroom + remove fails): surfaces the tagged paused error", async () => {
  const fake = wedgedFake({ removeFails: true });
  fake.quotaBytes = fake.usage(); // literally nothing more fits, ever
  const storage = await loadBundle("storage", "safari-ios", makeFakeChrome(fake));
  await assert.rejects(
    () => storage.enqueue([page(999)]),
    (e) => /even empty queue rejected/i.test(String(e)),
  );
});

test("kill mid-brim-escape: next context proceeds from a clean key", async () => {
  const fake = wedgedFake({
    onOp: (op, key) => {
      // Die immediately after the remove that frees the queue key.
      if (op === "remove" && key === "wtm:queue" && !fake._killed) {
        fake._killed = true;
        throw new SimulatedKill(op, key);
      }
    },
  });
  const storage = await loadBundle("storage", "safari-ios", makeFakeChrome(fake));
  await assert.rejects(() => storage.enqueue([page(999)]), SimulatedKill);
  // "Restart": fresh module instance over the surviving storage contents.
  fake.onOp = () => {};
  const storage2 = await loadBundle("storage", "safari-ios", makeFakeChrome(fake));
  await storage2.enqueue([page(1000)]);
  assert.equal(fake.snapshot()["wtm:queue"].v, 2, "fresh queue written after restart");
  assert.ok((await storage2.getQueueCount()) >= 1);
});
