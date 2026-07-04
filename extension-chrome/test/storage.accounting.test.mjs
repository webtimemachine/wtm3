import test from "node:test";
import assert from "node:assert/strict";
import { FakeStorageArea, makeFakeChrome } from "./fake-chrome.mjs";
import { loadBundle, page, randomText } from "./helpers.mjs";

// The 3.1.x root cause: code measured UTF-8 while Safari charges UTF-16, so
// every budget was ~2x optimistic. The safari-ios bundle must stay within a
// UTF-16-accounted quota that the utf8-measured code of old would have blown.

test("safari-ios: budget honored under UTF-16 accounting", async () => {
  // Real ceiling 500K UTF-16 bytes; iOS soft budget is 400K platform bytes,
  // measured the same way — so the stored payload must ALWAYS fit without a
  // single quota error if accounting is done right.
  const fake = new FakeStorageArea({ quotaBytes: 500_000, accounting: "utf16" });
  const storage = await loadBundle("storage", "safari-ios", makeFakeChrome(fake));
  for (let i = 0; i < 120; i++) {
    await storage.enqueue([{ ...page(i), text: randomText(8_000) }]); // incompressible
  }
  assert.equal(fake.usage() <= 500_000, true);
  const diags = await storage.getStorageDiagnostics();
  assert.equal(diags.accountingMode, "utf16");
  // No brim escapes needed: correct accounting means we trimmed BEFORE the
  // platform ever rejected a write.
  assert.equal(diags.brimEscapes, 0, "correct accounting avoids quota errors entirely");
  assert.ok((await storage.getQueueCount()) > 5, "retains a meaningful backlog");
});

test("safari-ios: per-page text cap prevents longread eviction", async () => {
  const fake = new FakeStorageArea();
  const storage = await loadBundle("storage", "safari-ios", makeFakeChrome(fake));
  await storage.enqueue([{ ...page(1), text: "x".repeat(200_000) }]);
  const q = await storage.getQueue();
  assert.equal(q[0].text.length, 60_000, "buffered text capped on iOS");
});

test("chrome: UTF-8 accounting, no page cap", async () => {
  const fake = new FakeStorageArea({ accounting: "utf8" });
  const storage = await loadBundle("storage", "chrome", makeFakeChrome(fake));
  await storage.enqueue([{ ...page(1), text: "x".repeat(200_000) }]);
  assert.equal((await storage.getQueue())[0].text.length, 200_000);
  assert.equal((await storage.getStorageDiagnostics()).accountingMode, "utf8");
});
