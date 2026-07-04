import test from "node:test";
import assert from "node:assert/strict";
import { FakeStorageArea, makeFakeChrome } from "./fake-chrome.mjs";
import { loadBundle, page, randomText } from "./helpers.mjs";

test("queue trims oldest to budget instead of failing", async () => {
  const fake = new FakeStorageArea({ quotaBytes: 150_000, accounting: "utf8" });
  const storage = await loadBundle("storage", "chrome", makeFakeChrome(fake));
  for (let i = 0; i < 40; i++) await storage.enqueue([{ ...page(i), text: randomText(10_000) }]);
  const q = await storage.getQueue();
  assert.ok(q.length > 3 && q.length < 40, `parked at ${q.length} — trimmed but retained backlog`);
  assert.equal(q.at(-1).id, "page-39", "newest capture retained; oldest trimmed");
});

test("learned ceiling: floored, persisted after success, expires after 7 days", async () => {
  const fake = new FakeStorageArea({ quotaBytes: 120_000, accounting: "utf8" });
  const storage = await loadBundle("storage", "chrome", makeFakeChrome(fake));
  for (let i = 0; i < 30; i++) await storage.enqueue([{ ...page(i), text: randomText(10_000) }]);
  const ceiling = fake.snapshot()["wtm:quotaCeiling"];
  assert.ok(ceiling, "ceiling persisted at its own key after a successful write");
  assert.ok(ceiling.bytes >= 65_536, "never below the floor");
  assert.ok(ceiling.bytes < 120_000, "learned below the real quota");
  assert.equal("quotaCeilingBytes" in (fake.snapshot()["wtm:state"] ?? {}), false, "never merged into state");

  // A fresh context adopts the persisted ceiling…
  const storage2 = await loadBundle("storage", "chrome", makeFakeChrome(fake));
  assert.equal((await storage2.getCeiling())?.bytes, ceiling.bytes);

  // …but ignores it once expired.
  fake.store.set("wtm:quotaCeiling", JSON.stringify({ bytes: ceiling.bytes, learnedAt: Date.now() - 8 * 24 * 3600_000 }));
  const storage3 = await loadBundle("storage", "chrome", makeFakeChrome(fake));
  assert.equal(await storage3.getCeiling(), null, "stale ceiling ignored on load");
});

test("ceiling heals upward after clean drains and clears at the platform default", async () => {
  const fake = new FakeStorageArea({
    seed: { "wtm:quotaCeiling": { bytes: 100_000, learnedAt: Date.now() } },
  });
  const storage = await loadBundle("storage", "chrome", makeFakeChrome(fake));
  await storage.raiseCeilingAfterCleanDrain();
  assert.equal((await storage.getCeiling())?.bytes, 110_000, "+10% per clean drain");
  // Raise repeatedly to the cap: the ceiling clears entirely.
  for (let i = 0; i < 60; i++) await storage.raiseCeilingAfterCleanDrain();
  assert.equal(await storage.getCeiling(), null, "fully healed ceilings are removed");
  assert.equal(fake.snapshot()["wtm:quotaCeiling"], undefined);
});
