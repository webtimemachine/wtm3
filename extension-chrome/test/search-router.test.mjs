import test from "node:test";
import assert from "node:assert/strict";
import { FakeStorageArea, makeFakeChrome } from "./fake-chrome.mjs";
import { loadBundle } from "./helpers.mjs";

test("Safari router installs only explicit-prefix submitted-query rules", async () => {
  const chrome = makeFakeChrome(new FakeStorageArea());
  await loadBundle("background", "safari-ios", chrome);
  const response = await chrome.runtime.sendMessage({
    type: "setState",
    patch: { searchRouterEnabled: true },
  });
  assert.equal(response.ok, true);
  const update = chrome.declarativeNetRequest._updates.at(-1);
  assert.deepEqual(update.removeRuleIds, [9101, 9102, 9103]);
  assert.equal(update.addRules.length, 3);
  for (const rule of update.addRules) {
    assert.equal(rule.action.type, "redirect");
    assert.match(rule.condition.regexFilter, /wtm/);
    assert.match(rule.condition.regexFilter, /%21/);
    assert.equal(rule.action.redirect.regexSubstitution, "https://webtm.io/search?q=\\1");
  }
});

test("Safari router removal leaves ordinary searches untouched", async () => {
  const chrome = makeFakeChrome(new FakeStorageArea());
  await loadBundle("background", "safari-ios", chrome);
  await chrome.runtime.sendMessage({
    type: "setState",
    patch: { searchRouterEnabled: false },
  });
  const update = chrome.declarativeNetRequest._updates.at(-1);
  assert.deepEqual(update.addRules, []);
});
