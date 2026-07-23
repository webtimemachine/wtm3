import test from "node:test";
import assert from "node:assert/strict";
import { FakeStorageArea, makeFakeChrome } from "./fake-chrome.mjs";
import { loadBundle, page } from "./helpers.mjs";

const CORRUPT_ENVELOPE = { v: 2, n: 5, gz: "definitely!!not@@base64##gzip" };

test("reads never write: popup-safe getQueue on corrupt data", async () => {
  const fake = new FakeStorageArea({ seed: { "wtm:queue": CORRUPT_ENVELOPE } });
  const storage = await loadBundle("storage", "chrome", makeFakeChrome(fake));
  assert.deepEqual(await storage.getQueue(), []);
  assert.deepEqual(fake.snapshot()["wtm:queue"], CORRUPT_ENVELOPE, "corrupt payload untouched by a read");
});

test("next mutation quarantines the evidence instead of silently overwriting", async () => {
  const fake = new FakeStorageArea({ seed: { "wtm:queue": CORRUPT_ENVELOPE } });
  const storage = await loadBundle("storage", "chrome", makeFakeChrome(fake));
  await storage.enqueue([page(1)]);
  const snap = fake.snapshot();
  assert.deepEqual(snap["wtm:queue:corrupt"]?.raw, CORRUPT_ENVELOPE, "evidence preserved");
  assert.equal(snap["wtm:queue"].n, 1, "clean queue restarted with the new capture");
});

test("quarantine is one-shot and size-guarded", async () => {
  const fake = new FakeStorageArea({
    seed: { "wtm:queue": CORRUPT_ENVELOPE, "wtm:queue:corrupt": { at: 1, raw: "earlier evidence" } },
  });
  const storage = await loadBundle("storage", "chrome", makeFakeChrome(fake));
  await storage.enqueue([page(1)]);
  assert.deepEqual(fake.snapshot()["wtm:queue:corrupt"], { at: 1, raw: "earlier evidence" }, "first evidence kept");

  // Oversized corruption on a constrained device stores a stub, not the blob.
  const huge = { v: 2, n: 1, gz: "A".repeat(300_000) };
  const fake2 = new FakeStorageArea({ seed: { "wtm:queue": huge } });
  const storage2 = await loadBundle("storage", "safari-ios", makeFakeChrome(fake2));
  await storage2.enqueue([page(1)]);
  const evidence = fake2.snapshot()["wtm:queue:corrupt"];
  assert.equal(evidence.stub, true, "oversized evidence stored as stub");
  assert.ok(evidence.bytes > 300_000);
});
