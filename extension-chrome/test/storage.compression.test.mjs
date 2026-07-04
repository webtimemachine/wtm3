import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { FakeStorageArea, makeFakeChrome } from "./fake-chrome.mjs";
import { loadBundle, page } from "./helpers.mjs";

test("queue writes v2 envelope with count; round-trips", async () => {
  const fake = new FakeStorageArea();
  const storage = await loadBundle("storage", "chrome", makeFakeChrome(fake));
  await storage.enqueue([page(1), page(2), page(3)]);
  const stored = fake.snapshot()["wtm:queue"];
  assert.equal(stored.v, 2);
  assert.equal(stored.n, 3);
  assert.equal(typeof stored.gz, "string");
  assert.deepEqual((await storage.getQueue()).map((p) => p.id), ["page-1", "page-2", "page-3"]);
  assert.equal(await storage.getQueueCount(), 3);
});

test("reads legacy v1 envelope (CompressionStream-era gzip)", async () => {
  const pages = [page(7), page(8)];
  const gz = gzipSync(Buffer.from(JSON.stringify(pages))).toString("base64");
  const fake = new FakeStorageArea({ seed: { "wtm:queue": { v: 1, gz } } });
  const storage = await loadBundle("storage", "chrome", makeFakeChrome(fake));
  assert.deepEqual((await storage.getQueue()).map((p) => p.id), ["page-7", "page-8"]);
});

test("reads pre-compression plain array and migrates it on removeSyncedIds", async () => {
  const fake = new FakeStorageArea({ seed: { "wtm:queue": [page(1), page(2)] } });
  const storage = await loadBundle("storage", "chrome", makeFakeChrome(fake));
  assert.equal(await storage.getQueueCount(), 2);
  await storage.removeSyncedIds(new Set(["page-1"]));
  const stored = fake.snapshot()["wtm:queue"];
  assert.equal(stored.v, 2, "legacy format migrated to v2 on first mutation");
  assert.equal(stored.n, 1);
});

test("compression multiplies capacity for realistic text", async () => {
  const fake = new FakeStorageArea({ quotaBytes: 200_000, accounting: "utf8" });
  const storage = await loadBundle("storage", "chrome", makeFakeChrome(fake));
  // 60 pages x ~15KB repetitive text = ~900KB raw against a 200KB quota.
  const pages = Array.from({ length: 60 }, (_, i) => page(i, 15_000));
  await storage.enqueue(pages);
  assert.equal(await storage.getQueueCount(), 60, "all pages fit compressed");
});

test("enqueue dedupes by URL replacing in place with the fresher capture", async () => {
  const fake = new FakeStorageArea();
  const storage = await loadBundle("storage", "chrome", makeFakeChrome(fake));
  await storage.enqueue([page(1), page(2)]);
  const revisit = { ...page(1), id: "page-1-revisit", text: "fresher text", visitedAt: 9999999999999 };
  await storage.enqueue([revisit]);
  const q = await storage.getQueue();
  assert.equal(q.length, 2, "no duplicate URL entries");
  assert.equal(q[0].id, "page-1-revisit", "queued entry replaced in place, keeping position");
  assert.equal(q[0].text, "fresher text");
});
