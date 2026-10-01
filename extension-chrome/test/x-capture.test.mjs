import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { loadBundle } from "./helpers.mjs";

const POSTED = "2026-09-30T16:38:00.000Z";
const FIRST_URL = "https://x.com/bubbleboi/status/2105336578868740335";

function tweet({ id = "2105336578868740335", handle = "bubbleboi", text = "Westinghouse W501B generators", extra = "", hidden = "", publicLayout = false } = {}) {
  return `<article ${hidden} ${publicLayout ? "" : 'data-testid="tweet"'}>
    <div ${publicLayout ? "" : 'data-testid="User-Name"'}>
      <a href="/${handle}">Display ${handle}</a><a href="/${handle}">@${handle}</a>
      <a href="/${handle}/status/${id}?s=20" ${publicLayout ? 'data-base-ui-tooltip-trigger=""' : ""}>
        ${publicLayout ? "12:38 PM · Sep 30, 2026" : `<time datetime="${POSTED}">1h</time>`}
      </a>
    </div>
    ${text === null ? "" : `<div ${publicLayout ? 'dir="auto" class="whitespace-pre-wrap"' : 'data-testid="tweetText"'}>${text}</div>`}
    ${extra}<button>Like 100</button><nav>Keyboard shortcuts</nav>
  </article>`;
}

function dom(body) {
  const { document, window, HTMLElement } = parseHTML(`<!doctype html><html lang="en"><head><title>Home / X</title></head><body>${body}</body></html>`);
  window.innerHeight = 900;
  window.innerWidth = 1200;
  window.getComputedStyle = (element) => ({
    display: element.style.display || "block",
    visibility: element.style.visibility || "visible",
    opacity: element.style.opacity || "1",
    overflowY: element.style.overflowY || "visible",
    overflowX: element.style.overflowX || "visible",
  });
  HTMLElement.prototype.getBoundingClientRect = function () {
    const top = Number(this.getAttribute("data-top") || 100);
    const height = Number(this.getAttribute("data-height") || 120);
    return { top, bottom: top + height, left: 100, right: 700, width: 600, height };
  };
  Object.defineProperty(document, "visibilityState", { value: "visible", writable: true });
  return { document, window };
}

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

async function advance(t, milliseconds = 500) {
  // Advance in scan-sized steps so interval callbacks can schedule timers and
  // asynchronous acknowledgements settle between successive scans.
  for (let remaining = milliseconds; remaining > 0; remaining -= 500) {
    await settle();
    t.mock.timers.tick(Math.min(500, remaining));
    await settle();
  }
}

async function boot(t, platform, html, { url = "https://x.com/home", send } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1790787000000 });
  const { document, window } = dom(html);
  const previous = globalThis.MutationObserver;
  globalThis.MutationObserver = window.MutationObserver;
  const { startXCapture } = await loadBundle("x-capture", platform, {});
  const captures = [];
  const route = { url };
  const stop = startXCapture(document, () => route.url, async (page) => {
    captures.push(page);
    return send ? send(page, captures.length) : { ok: true };
  });
  t.after(() => { stop(); globalThis.MutationObserver = previous; });
  return { document, window, captures, route };
}

for (const platform of ["chrome", "safari-ios"]) {
  test(`${platform}: saves each visible post with canonical link, author and posting time`, async (t) => {
    const { captures } = await boot(t, platform, tweet() + tweet({ handle: "another", id: "2105336578868740336", text: "A different post" }));
    await advance(t);
    assert.equal(captures.length, 2);
    assert.equal(captures[0].url, FIRST_URL);
    assert.equal(captures[0].byline, "Display bubbleboi (@bubbleboi)");
    assert.match(captures[0].text, new RegExp(POSTED.replaceAll(".", "\\.")));
    assert.match(captures[0].text, /Westinghouse W501B/);
    assert.doesNotMatch(captures[0].text, /different post|Like 100|Keyboard shortcuts/);
    assert.equal(captures[0].visitedAt, 1790787000000 + 500);
    assert.equal(captures[0].lang, "en");
  });

  test(`${platform}: supports the newer public X layout without test IDs or <time>`, async (t) => {
    const { captures } = await boot(t, platform, tweet({ publicLayout: true }));
    await advance(t);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].url, FIRST_URL);
    assert.match(captures[0].text, /Posted: 12:38 PM · Sep 30, 2026/);
  });

  test(`${platform}: rejects shells and captures posts that render after the initial scan`, async (t) => {
    const { document, captures } = await boot(t, platform, "<nav>To view keyboard shortcuts, press question mark</nav>" + tweet({ text: null }));
    await advance(t, 12000);
    assert.equal(captures.length, 0);
    document.body.innerHTML = tweet();
    await advance(t);
    assert.equal(captures.length, 1);
    assert.match(captures[0].text, /W501B/);
  });

  test(`${platform}: captures newly visible posts when scrolling without a URL change`, async (t) => {
    const { document, window, captures } = await boot(t, platform, tweet({ hidden: 'data-top="2000"' }));
    await advance(t);
    assert.equal(captures.length, 0);
    document.querySelector("article").setAttribute("data-top", "100");
    document.dispatchEvent(new window.Event("scroll"));
    await advance(t);
    assert.equal(captures.length, 1);
  });

  test(`${platform}: ignores posts clipped by a scroll container or hidden by CSS`, async (t) => {
    const { document, window, captures } = await boot(t, platform,
      `<div style="overflow-y: auto" data-top="100" data-height="100">${tweet({ hidden: 'data-top="300"' })}</div>`
      + tweet({ id: "2105336578868740336", hidden: 'style="visibility:hidden"' })
      + tweet({ id: "2105336578868740337", hidden: 'aria-hidden="true"' }));
    await advance(t);
    assert.equal(captures.length, 0);
    document.querySelector("article").setAttribute("data-top", "120");
    document.dispatchEvent(new window.Event("scroll"));
    await advance(t);
    assert.equal(captures.length, 1);
  });

  test(`${platform}: refreshed and recycled feed cells use their own permalink`, async (t) => {
    const { document, captures } = await boot(t, platform, tweet());
    await advance(t);
    document.querySelector("article").innerHTML = dom(tweet({ handle: "other", id: "2105336578868740336", text: "Next virtualized post" })).document.querySelector("article").innerHTML;
    await advance(t);
    assert.equal(captures.length, 2);
    assert.equal(captures[1].url, "https://x.com/other/status/2105336578868740336");
    assert.doesNotMatch(captures[1].text, /bubbleboi|W501B/);
  });

  test(`${platform}: expanding text updates the same capture ID and visit time`, async (t) => {
    const { document, captures } = await boot(t, platform, tweet());
    await advance(t);
    document.querySelector('[data-testid="tweetText"]').textContent += " with the complete specifications and extra details";
    await advance(t);
    assert.equal(captures.length, 2);
    assert.equal(captures[0].id, captures[1].id);
    assert.equal(captures[0].visitedAt, captures[1].visitedAt);
    assert.match(captures[1].text, /complete specifications/);
    await advance(t, 10000);
    assert.equal(captures.length, 2, "unchanged posts must not enqueue again");
    document.querySelector('[data-testid="tweetText"]').textContent = "Westinghouse W501B generators…";
    await advance(t);
    assert.equal(captures.length, 2, "a truncated feed cell must not overwrite expanded text");
  });

  test(`${platform}: quoted content can't replace the enclosing post's identity or text`, async (t) => {
    const quote = `<div role="link" data-testid="quoteTweet"><a href="/quoted/status/2105336578868740336"><time datetime="${POSTED}">1h</time></a><div data-testid="tweetText">Quoted unrelated text</div></div>`;
    const { captures } = await boot(t, platform, tweet({ extra: quote }));
    await advance(t);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].url, FIRST_URL);
    assert.doesNotMatch(captures[0].text, /Quoted unrelated/);
  });

  test(`${platform}: preserves emoji and photo descriptions without UI text`, async (t) => {
    const { captures } = await boot(t, platform, tweet({ text: 'Power <img alt="⚡" src="emoji.svg">', extra: '<div data-testid="tweetPhoto"><img alt="The W501B nameplate" src="https://pbs.twimg.com/media/example.jpg"></div>' }));
    await advance(t);
    assert.equal(captures.length, 1);
    assert.match(captures[0].text, /Power ⚡/);
    assert.match(captures[0].text, /Photo: The W501B nameplate/);
    assert.doesNotMatch(captures[0].text, /Keyboard shortcuts/);
  });

  test(`${platform}: media-only posts have a searchable author and permalink`, async (t) => {
    const { captures } = await boot(t, platform, tweet({ text: null, extra: '<div data-testid="tweetPhoto"><img alt="Image" src="photo.jpg"></div>' }));
    await advance(t);
    assert.equal(captures.length, 1);
    assert.match(captures[0].text, /\[Photo\]/);
  });

  test(`${platform}: skips composer and message routes even with a stale post DOM`, async (t) => {
    const { route, captures } = await boot(t, platform, tweet(), { url: "https://x.com/compose/post" });
    await advance(t);
    assert.equal(captures.length, 0);
    for (const path of ["/messages", "/i/chat", "/i/flow/login", "/i/jf/onboarding/web", "/settings/account"]) {
      route.url = `https://x.com${path}`;
      await advance(t, 3000);
    }
    assert.equal(captures.length, 0);
    route.url = FIRST_URL;
    await advance(t, 3000);
    assert.equal(captures.length, 1);
  });

  test(`${platform}: does not capture background tabs until they become visible`, async (t) => {
    const { document, window, captures } = await boot(t, platform, tweet());
    document.visibilityState = "hidden";
    await advance(t);
    assert.equal(captures.length, 0);
    document.visibilityState = "visible";
    document.dispatchEvent(new window.Event("visibilitychange"));
    await advance(t);
    assert.equal(captures.length, 1);
  });

  test(`${platform}: retries failed and disabled captures instead of marking them saved`, async (t) => {
    const { captures } = await boot(t, platform, tweet(), { send: (_page, count) => {
      if (count === 1) throw new Error("worker unavailable");
      return count === 2 ? { ok: true, skipped: true } : { ok: true };
    } });
    await advance(t);
    await advance(t, 3000);
    await advance(t, 3000);
    assert.equal(captures.length, 3);
    assert.equal(new Set(captures.map((capture) => capture.id)).size, 1);
    await advance(t, 10000);
    assert.equal(captures.length, 3);
  });

  test(`${platform}: coalesces duplicates and does not enqueue while a send is pending`, async (t) => {
    let finish;
    const { captures } = await boot(t, platform, tweet() + tweet(), { send: () => new Promise((resolve) => { finish = resolve; }) });
    await advance(t);
    await advance(t, 10000);
    assert.equal(captures.length, 1);
    finish({ ok: true });
    await settle();
    await advance(t, 10000);
    assert.equal(captures.length, 1);
  });

  test(`${platform}: normalizes legacy Twitter and media-viewer links to the post`, async (t) => {
    const html = tweet().replace('/bubbleboi/status/2105336578868740335?s=20', 'https://mobile.twitter.com/bubbleboi/status/2105336578868740335/photo/1?token=secret');
    const { captures } = await boot(t, platform, html, { url: "https://mobile.twitter.com/home" });
    await advance(t);
    assert.equal(captures[0].url, FIRST_URL);
    assert.doesNotMatch(JSON.stringify(captures), /secret|photo\/1/);
  });

  test(`${platform}: external status-like links cannot identify a post`, async (t) => {
    const html = tweet().replace('/bubbleboi/status/2105336578868740335?s=20', 'https://example.com/bubbleboi/status/2105336578868740335');
    const { captures } = await boot(t, platform, html);
    await advance(t);
    assert.equal(captures.length, 0);
  });
}

test("the real content script uses the X adapter, never the whole-page fallback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { document, window } = dom("<nav>To view keyboard shortcuts, press question mark</nav>");
  globalThis.document = document;
  globalThis.location = { href: "https://x.com/home" };
  globalThis.MutationObserver = window.MutationObserver;
  const captures = [];
  await loadBundle("content", "chrome", { runtime: { sendMessage: async (message) => { captures.push(message.page); return { ok: true }; } } });
  await advance(t, 12000);
  assert.equal(captures.length, 0);
  document.body.innerHTML = tweet();
  await advance(t);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].url, FIRST_URL);
});

test("ordinary article pages still use readable whole-page capture", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const text = "Ordinary articles should keep capturing their readable text. ".repeat(15);
  const { document } = dom(`<main><article><h1>Article</h1><p>${text}</p></article></main>`);
  globalThis.document = document;
  globalThis.location = { href: "https://example.com/article" };
  const captures = [];
  await loadBundle("content", "chrome", { runtime: { sendMessage: async (message) => { captures.push(message.page); return { ok: true }; } } });
  await advance(t, 12000);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].url, "https://example.com/article");
  assert.match(captures[0].text, /Ordinary articles should keep capturing/);
});
