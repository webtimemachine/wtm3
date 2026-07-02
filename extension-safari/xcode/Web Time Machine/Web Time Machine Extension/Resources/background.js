"use strict";
(() => {
  // ../shared/src/index.ts
  var DEFAULT_BACKEND = "https://api.webtm.io";
  var Routes = {
    register: "/auth/register",
    login: "/auth/login",
    me: "/auth/me",
    settings: "/settings",
    nodes: "/nodes",
    node: (id) => `/nodes/${id}`,
    syncPush: "/sync/push",
    syncPull: "/sync/pull",
    search: "/search",
    recent: "/pages",
    page: (id) => `/pages/${id}`,
    pageText: (id) => `/pages/${id}/text`,
    health: "/health"
  };

  // ../shared/src/api.ts
  var WtmApiError = class extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
      this.name = "WtmApiError";
    }
  };
  var WtmClient = class {
    baseUrl;
    token;
    f;
    constructor(opts) {
      this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
      this.token = opts.token ?? null;
      this.f = opts.fetchImpl ?? fetch.bind(globalThis);
    }
    setToken(token) {
      this.token = token;
    }
    get hasToken() {
      return !!this.token;
    }
    async req(method, path, body) {
      const headers = {};
      if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
      if (body !== void 0) headers["Content-Type"] = "application/json";
      const res = await this.f(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== void 0 ? JSON.stringify(body) : void 0
      });
      if (!res.ok) {
        let err = { error: "http_error", message: `HTTP ${res.status}` };
        try {
          err = await res.json();
        } catch {
        }
        throw new WtmApiError(res.status, err.error ?? "http_error", err.message ?? `HTTP ${res.status}`);
      }
      if (res.status === 204) return void 0;
      return await res.json();
    }
    // --- auth ---
    register(req) {
      return this.req("POST", Routes.register, req);
    }
    login(req) {
      return this.req("POST", Routes.login, req);
    }
    me() {
      return this.req("GET", Routes.me);
    }
    updateSettings(body) {
      return this.req("PATCH", Routes.settings, body);
    }
    // --- nodes ---
    registerNode(req) {
      return this.req("POST", Routes.nodes, req);
    }
    listNodes() {
      return this.req("GET", Routes.nodes);
    }
    renameNode(id, name) {
      return this.req("PATCH", Routes.node(id), { name });
    }
    // --- sync ---
    push(req) {
      return this.req("POST", Routes.syncPush, req);
    }
    pull(since, limit = 500) {
      return this.req("GET", `${Routes.syncPull}?since=${since}&limit=${limit}`);
    }
    // --- search & pages ---
    search(query, opts = {}) {
      const p = new URLSearchParams({ q: query });
      if (opts.limit != null) p.set("limit", String(opts.limit));
      if (opts.offset != null) p.set("offset", String(opts.offset));
      return this.req("GET", `${Routes.search}?${p.toString()}`);
    }
    recent(opts = {}) {
      const p = new URLSearchParams();
      if (opts.limit != null) p.set("limit", String(opts.limit));
      if (opts.before != null) p.set("before", String(opts.before));
      const qs = p.toString();
      return this.req("GET", qs ? `${Routes.recent}?${qs}` : Routes.recent);
    }
    getPage(id) {
      return this.req("GET", Routes.page(id));
    }
    async getText(id) {
      const headers = {};
      if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
      const res = await this.f(`${this.baseUrl}${Routes.pageText(id)}`, { headers });
      if (!res.ok) throw new WtmApiError(res.status, "http_error", `HTTP ${res.status}`);
      return res.text();
    }
    async deletePage(id) {
      await this.req("DELETE", Routes.page(id));
    }
  };

  // ../extension-chrome/src/config.ts
  var PLATFORM = true ? "safari-ios" : "chrome";
  function deviceOwnerKey(baseUrl, userId) {
    return `${baseUrl}|${userId}`;
  }
  var DEFAULT_STATE = {
    baseUrl: DEFAULT_BACKEND,
    token: null,
    user: null,
    deviceId: null,
    deviceOwner: null,
    captureEnabled: true,
    lastSync: null,
    lastError: null,
    lastErrorAt: null
  };

  // ../extension-chrome/src/storage.ts
  var STATE_KEY = "wtm:state";
  var QUEUE_KEY = "wtm:queue";
  var QUEUE_SOFT_BYTES = 4e6;
  var quotaCeilingBytes = null;
  function noteQuotaHit(failedBytes) {
    const ceiling = Math.floor(failedBytes * 0.75);
    quotaCeilingBytes = quotaCeilingBytes === null ? ceiling : Math.min(quotaCeilingBytes, ceiling);
  }
  function byteSize(value) {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  }
  function isQuotaError(e) {
    const s = `${e?.message ?? e}`.toLowerCase();
    return s.includes("quota") || s.includes("exceeded");
  }
  var hasCompression = typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 32768) {
      s += String.fromCharCode(...bytes.subarray(i, i + 32768));
    }
    return btoa(s);
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  async function gzipText(text) {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    return bufToB64(await new Response(stream).arrayBuffer());
  }
  async function gunzipText(b64) {
    const stream = new Blob([b64ToBytes(b64)]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  async function encodeQueue(pages) {
    if (!hasCompression) return pages;
    return { v: 1, gz: await gzipText(JSON.stringify(pages)) };
  }
  function dropOldest(q, fraction) {
    return q.length <= 1 ? [] : q.slice(Math.max(1, Math.ceil(q.length * fraction)));
  }
  function tagError(op, e) {
    return new Error(`${op}: ${e?.message ?? e}`);
  }
  var queueLock = Promise.resolve();
  function withQueueLock(fn) {
    const run = queueLock.then(fn, fn);
    queueLock = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  async function getState() {
    const o = await chrome.storage.local.get(STATE_KEY);
    return { ...DEFAULT_STATE, ...o[STATE_KEY] ?? {} };
  }
  async function setState(patch) {
    const next = { ...await getState(), ...patch };
    for (; ; ) {
      try {
        await chrome.storage.local.set({ [STATE_KEY]: next });
        return next;
      } catch (e) {
        if (!isQuotaError(e)) throw e;
        const q = await getQueue();
        if (q.length === 0) throw tagError("state write (queue already empty)", e);
        noteQuotaHit(byteSize(next) + byteSize(q));
        await setQueue(dropOldest(q, 0.25));
      }
    }
  }
  async function getQueue() {
    const o = await chrome.storage.local.get(QUEUE_KEY);
    const raw = o[QUEUE_KEY];
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === "object" && raw.v === 1) {
      try {
        return JSON.parse(await gunzipText(raw.gz));
      } catch {
        return [];
      }
    }
    return [];
  }
  async function setQueue(q) {
    const budget = Math.min(QUEUE_SOFT_BYTES, quotaCeilingBytes ?? Number.POSITIVE_INFINITY);
    let pages = q;
    let payload = await encodeQueue(pages);
    while (pages.length > 1 && byteSize(payload) > budget) {
      pages = dropOldest(pages, 0.1);
      payload = await encodeQueue(pages);
    }
    for (; ; ) {
      try {
        await chrome.storage.local.set({ [QUEUE_KEY]: payload });
        return;
      } catch (e) {
        if (!isQuotaError(e)) throw e;
        if (pages.length === 0) throw tagError("queue write (even empty queue rejected)", e);
        noteQuotaHit(byteSize(payload));
        pages = dropOldest(pages, 0.25);
        payload = await encodeQueue(pages);
      }
    }
  }
  async function enqueue(pages) {
    return withQueueLock(async () => {
      const q = await getQueue();
      const urls = new Set(q.map((p) => p.url));
      const fresh = pages.filter((p) => !urls.has(p.url));
      if (fresh.length) await setQueue([...q, ...fresh]);
      return fresh.length;
    });
  }

  // ../extension-chrome/src/background.ts
  var FLUSH_ALARM = "wtm:flush";
  var BATCH = 50;
  var BATCH_SOFT_BYTES = 1e6;
  function takeBatch(queue) {
    const batch = [];
    let bytes = 0;
    for (const p of queue.slice(0, BATCH)) {
      bytes += (p.text?.length ?? 0) + 512;
      if (batch.length && bytes > BATCH_SOFT_BYTES) break;
      batch.push(p);
    }
    return batch;
  }
  var flushTimer = null;
  var flushing = false;
  var cachedNode = null;
  chrome.runtime.onInstalled.addListener(async () => {
    await getState();
    chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
  });
  chrome.runtime.onStartup.addListener(() => {
    chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
  });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === FLUSH_ALARM) void flush();
  });
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg?.type === "capture" && msg.page) {
          const st = await getState();
          if (!st.captureEnabled) return sendResponse({ ok: true, skipped: true });
          const page = { id: crypto.randomUUID(), ...msg.page };
          const added = await enqueue([page]);
          if (added) scheduleFlush();
          return sendResponse({ ok: true, added });
        }
        if (msg?.type === "flushNow" || msg?.type === "authChanged") {
          await flush();
          return sendResponse({ ok: true });
        }
        sendResponse({ ok: false, error: "unknown_message" });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  });
  function scheduleFlush(delay = 2500) {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, delay);
  }
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      const st = await getState();
      if (!st.token || !st.baseUrl) return;
      if (!(await getQueue()).length) return;
      const client = new WtmClient({ baseUrl: st.baseUrl, token: st.token });
      const owner = deviceOwnerKey(st.baseUrl, st.user?.id ?? "");
      let deviceId = st.deviceId ?? (cachedNode?.owner === owner ? cachedNode.id : null);
      if (!deviceId) {
        const node = await client.registerNode({ name: deviceName(), platform: PLATFORM });
        deviceId = node.id;
      }
      cachedNode = { id: deviceId, owner };
      try {
        await setState({ deviceId, deviceOwner: owner });
      } catch {
      }
      while (true) {
        const current = await getQueue();
        if (!current.length) break;
        const batch = takeBatch(current);
        const acked = new Set(batch.map((p) => p.id));
        await client.push({ deviceId, pages: batch });
        await setState({ deviceId, deviceOwner: owner, lastSync: Date.now(), lastError: null, lastErrorAt: null });
        const stuck = await withQueueLock(async () => {
          const after = await getQueue();
          await setQueue(after.filter((p) => !acked.has(p.id)));
          const verify = await getQueue();
          return verify.some((p) => acked.has(p.id));
        });
        if (stuck) {
          throw new Error(
            `sync: ${batch.length} page(s) landed on the server but local storage didn't drop them \u2014 will retry`
          );
        }
      }
    } catch (e) {
      const msg = e instanceof WtmApiError ? `${e.status} ${e.message}` : isQuotaError(e) ? `Device storage was full \u2014 oldest unsynced captures were trimmed. Sync continues. [${e.message?.slice(0, 100) ?? e}]` : String(e);
      try {
        await setState({ lastError: msg, lastErrorAt: Date.now() });
        if (e instanceof WtmApiError && e.status === 401) {
          await setState({ token: null });
        }
      } catch {
      }
    } finally {
      flushing = false;
    }
  }
  function deviceName() {
    const ua = navigator.userAgent;
    if (PLATFORM === "safari-ios") {
      return /iPad/.test(ua) ? "Safari on iPad" : "Safari on iPhone";
    }
    if (PLATFORM === "firefox-android") return "Firefox on Android";
    const os = /Macintosh|Mac OS/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux|X11/.test(ua) ? "Linux" : "Chrome";
    return `Chrome on ${os}`;
  }
})();
