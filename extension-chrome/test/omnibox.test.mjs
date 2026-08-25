import test from "node:test";
import assert from "node:assert/strict";
import { FakeStorageArea, makeFakeChrome } from "./fake-chrome.mjs";
import { loadBundle, makeFetch } from "./helpers.mjs";

test("omnibox uses the separately approved assist token", async () => {
  const storage = new FakeStorageArea({
    seed: {
      "wtm:state": {
        baseUrl: "https://api.test",
        assistToken: "wtm_assist",
        assistEnabled: true,
      },
    },
  });
  const chrome = makeFakeChrome(storage);
  const fetch = makeFetch({
    "GET /suggest": {
      query: "linear",
      suggestions: [
        {
          id: "p1",
          url: "https://example.com/linear",
          title: "Linear history",
          visitedAt: 1,
        },
      ],
    },
  });
  await loadBundle("background", "chrome", chrome, { fetchImpl: fetch });

  const suggestions = await chrome.omnibox._change("linear");
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].content, "https://example.com/linear");
  assert.match(suggestions[0].description, /Linear history/);
  assert.equal(fetch.calls[0].path, "/suggest");
});

test("omnibox falls back to URL-addressable WTM search", async () => {
  const chrome = makeFakeChrome(new FakeStorageArea());
  await loadBundle("background", "chrome", chrome);
  chrome.omnibox._enter("a remembered phrase", "currentTab");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(chrome.tabs._calls[0].method, "update");
  assert.equal(
    chrome.tabs._calls[0].url,
    "https://webtm.io/search?q=a+remembered+phrase",
  );
});
