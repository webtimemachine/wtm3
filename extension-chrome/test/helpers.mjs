// Loads fresh, independent instances of the built bundles. Each import gets a
// cache-busting query so module-level state (locks, learned ceilings, caches)
// starts clean — this is how tests model separate JS contexts (background vs
// popup) and iOS killing + restarting the worker. node --test runs each test
// file in its own process and tests serially within a file, so mutating
// globalThis.chrome between loads is safe.

let counter = 0;

export async function loadBundle(entry, platform, chromeObj, { fetchImpl, userAgent = "iPhone test" } = {}) {
  globalThis.chrome = chromeObj;
  try {
    Object.defineProperty(globalThis, "navigator", { value: { userAgent }, configurable: true });
  } catch {
    /* keep node's navigator if not configurable */
  }
  if (fetchImpl) globalThis.fetch = fetchImpl;
  const url = new URL(`./.build/${entry}.${platform}.mjs`, import.meta.url).href + `?i=${counter++}`;
  return import(url);
}

/** Scriptable fetch stub for flush tests. Routes by method+pathname. */
export function makeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : null });
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected fetch ${method} ${path}`);
    const result = typeof handler === "function" ? handler(calls.at(-1)) : handler;
    if (result instanceof Response) return result;
    const { status = 200, json = result } = result?.status ? result : { json: result };
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
  impl.calls = calls;
  return impl;
}

export function page(i, textLen = 5000) {
  return {
    id: `page-${i}`,
    url: `https://example.com/a/${i}`,
    title: `Article ${i}`,
    visitedAt: 1750000000000 + i,
    text: `content ${i} `.repeat(Math.ceil(textLen / 11)).slice(0, textLen),
    excerpt: `excerpt ${i}`,
    byline: null,
    lang: "en",
  };
}

/** Incompressible text, for tests where gzip must not dodge the quota. */
export function randomText(len) {
  let s = "";
  while (s.length < len) s += Math.random().toString(36).slice(2);
  return s.slice(0, len);
}
