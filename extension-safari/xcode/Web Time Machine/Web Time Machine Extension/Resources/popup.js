"use strict";
(() => {
  // ../shared/src/index.ts
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

  // ../shared/src/format.ts
  function snippetHtml(s) {
    const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return esc.replaceAll("&lt;mark&gt;", "<mark>").replaceAll("&lt;/mark&gt;", "</mark>");
  }
  function timeAgo(ms) {
    const s = Math.round((Date.now() - ms) / 1e3);
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const hr = Math.round(m / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.round(hr / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(ms).toLocaleDateString();
  }

  // ../extension-chrome/src/config.ts
  var DEFAULT_BACKEND = "https://api.webtm.io";
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
        if (q.length === 0) throw e;
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
        if (!isQuotaError(e) || pages.length === 0) throw e;
        noteQuotaHit(byteSize(payload));
        pages = dropOldest(pages, 0.25);
        payload = await encodeQueue(pages);
      }
    }
  }

  // ../extension-chrome/src/popup.ts
  var app = document.getElementById("app");
  function h(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v;
      else e.setAttribute(k, v);
    }
    for (const c of children) e.append(c);
    return e;
  }
  async function client() {
    const st = await getState();
    return new WtmClient({ baseUrl: st.baseUrl, token: st.token });
  }
  async function renderAuth(errorMsg) {
    const st = await getState();
    app.replaceChildren();
    app.append(
      h("header", {}, [h("span", { class: "brand", html: 'Web Time <span class="dot">Machine</span>' })])
    );
    const urlField = h("input", { type: "text", id: "url", value: st.baseUrl || DEFAULT_BACKEND });
    const emailField = h("input", { type: "email", id: "email", placeholder: "you@example.com" });
    const passField = h("input", { type: "password", id: "pass", placeholder: "password (8+ chars)" });
    const err = h("div", { class: "error" }, [errorMsg ?? ""]);
    const loginBtn = h("button", {}, ["Log in"]);
    const registerBtn = h("button", { class: "secondary" }, ["Create account"]);
    async function submit(register) {
      err.textContent = "";
      const baseUrl = urlField.value.trim() || DEFAULT_BACKEND;
      const email = emailField.value.trim();
      const password = passField.value;
      if (!email || !password) {
        err.textContent = "Email and password required.";
        return;
      }
      loginBtn.disabled = registerBtn.disabled = true;
      try {
        const c = new WtmClient({ baseUrl });
        const res = register ? await c.register({ email, password }) : await c.login({ email, password });
        const prev = await getState();
        const owner = deviceOwnerKey(baseUrl, res.user.id);
        const deviceId = prev.deviceOwner === owner ? prev.deviceId : null;
        await setState({ baseUrl, token: res.token, user: res.user, deviceId, deviceOwner: owner, lastError: null });
        chrome.runtime.sendMessage({ type: "authChanged" });
        await renderApp();
      } catch (e) {
        err.textContent = e instanceof WtmApiError ? e.message : `Could not reach ${baseUrl}`;
        loginBtn.disabled = registerBtn.disabled = false;
      }
    }
    loginBtn.addEventListener("click", () => void submit(false));
    registerBtn.addEventListener("click", () => void submit(true));
    passField.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void submit(false);
    });
    app.append(
      h("div", { class: "section" }, [
        h("div", { class: "field" }, [h("label", {}, ["Backend URL"]), urlField]),
        h("div", { class: "field" }, [h("label", {}, ["Email"]), emailField]),
        h("div", { class: "field" }, [h("label", {}, ["Password"]), passField]),
        h("div", { class: "row" }, [loginBtn, registerBtn]),
        err
      ])
    );
  }
  var searchTimer = null;
  async function renderApp() {
    const st = await getState();
    if (!st.token || !st.user) return renderAuth();
    app.replaceChildren();
    const captureToggle = h("input", { type: "checkbox" });
    captureToggle.checked = st.captureEnabled;
    captureToggle.addEventListener("change", () => void setState({ captureEnabled: captureToggle.checked }));
    const logout = h("button", { class: "link" }, ["Log out"]);
    logout.addEventListener("click", async () => {
      await setState({ token: null, user: null });
      await renderAuth();
    });
    app.append(
      h("header", {}, [
        h("span", { class: "brand", html: 'WTM<span class="dot">.</span>' }),
        h("span", { class: "email" }, [st.user.email]),
        h("span", { class: "spacer" }),
        h("label", { class: "toggle", title: "Capture pages" }, [captureToggle, "capture"]),
        logout
      ])
    );
    const queue = await getQueue();
    const status = h("div", { class: "section status" }, [
      h("span", {}, [h("b", {}, [String(queue.length)]), " queued"]),
      " \xB7 ",
      h("span", {}, [st.lastSync ? `synced ${timeAgo(st.lastSync)}` : "not synced yet"])
    ]);
    const ERROR_TTL_MS = 15 * 6e4;
    if (st.lastError && st.lastErrorAt && Date.now() - st.lastErrorAt < ERROR_TTL_MS) {
      const cls = /storage was full/i.test(st.lastError) ? "hint" : "error";
      status.append(h("div", { class: cls }, [`${st.lastError} (${timeAgo(st.lastErrorAt)})`]));
    }
    app.append(status);
    app.append(await buildSettings(st));
    const search = h("input", { type: "search", placeholder: "Search your history\u2026" });
    app.append(h("div", { class: "section" }, [search]));
    const results = h("div", { class: "results" }, [h("div", { class: "empty" }, ["Loading recent pages\u2026"])]);
    app.append(results);
    search.addEventListener("input", () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => void runSearch(search.value.trim(), results), 220);
    });
    await loadRecent(results);
  }
  async function buildSettings(st) {
    const filterCb = h("input", { type: "checkbox" });
    filterCb.checked = !!st.user?.filterSensitive;
    filterCb.addEventListener("change", async () => {
      filterCb.disabled = true;
      try {
        const u = await (await client()).updateSettings({ filterSensitive: filterCb.checked });
        await setState({ user: u });
      } catch {
        filterCb.checked = !filterCb.checked;
      } finally {
        filterCb.disabled = false;
      }
    });
    const daysInput = h("input", {
      type: "number",
      min: "1",
      max: "3650",
      value: String(st.user?.retentionDays ?? 90)
    });
    const daysBtn = h("button", { class: "secondary tiny" }, ["Save"]);
    const daysMsg = h("span", { class: "hint" }, []);
    daysBtn.addEventListener("click", async () => {
      const d = parseInt(daysInput.value, 10);
      if (!Number.isInteger(d) || d < 1 || d > 3650) {
        daysMsg.textContent = "1\u20133650 days";
        return;
      }
      daysBtn.disabled = true;
      daysMsg.textContent = "";
      try {
        const u = await (await client()).updateSettings({ retentionDays: d });
        await setState({ user: u });
        daysMsg.textContent = "Saved";
      } catch (e) {
        daysMsg.textContent = e instanceof WtmApiError ? e.message : "Failed";
      } finally {
        daysBtn.disabled = false;
      }
    });
    const children = [
      h("summary", {}, ["Settings"]),
      h("label", { class: "toggle" }, [filterCb, "Hide sensitive pages"]),
      h("div", { class: "field" }, [
        h("label", {}, ["History expiration (days)"]),
        h("div", { class: "row" }, [daysInput, daysBtn, daysMsg])
      ])
    ];
    if (st.deviceId) {
      const did = st.deviceId;
      let current = "";
      try {
        const { nodes } = await (await client()).listNodes();
        current = nodes.find((n) => n.id === did)?.name ?? "";
      } catch {
      }
      const nameInput = h("input", {
        type: "text",
        placeholder: "This device's name",
        value: current
      });
      const nameBtn = h("button", { class: "secondary tiny" }, ["Rename"]);
      const nameMsg = h("span", { class: "hint" }, []);
      nameBtn.addEventListener("click", async () => {
        const name = nameInput.value.trim();
        if (!name) return;
        nameBtn.disabled = true;
        nameMsg.textContent = "";
        try {
          await (await client()).renameNode(did, name);
          nameMsg.textContent = "Renamed";
        } catch (e) {
          nameMsg.textContent = e instanceof WtmApiError ? e.message : "Failed";
        } finally {
          nameBtn.disabled = false;
        }
      });
      children.push(
        h("div", { class: "field" }, [
          h("label", {}, ["This device"]),
          h("div", { class: "row" }, [nameInput, nameBtn, nameMsg])
        ])
      );
    }
    return h("details", { class: "section settings" }, children);
  }
  function renderHit(p, results) {
    const snippet = "snippet" in p && p.snippet ? h("div", { class: "snippet", html: snippetHtml(p.snippet) }) : null;
    const summary = p.summary && (!("snippet" in p) || !p.snippet) ? h("div", { class: "summary" }, [p.summary]) : null;
    const del = h("button", { class: "secondary tiny", title: "Delete everywhere" }, ["Delete"]);
    del.addEventListener("click", async () => {
      del.disabled = true;
      try {
        await (await client()).deletePage(p.id);
        row.remove();
      } catch {
        del.disabled = false;
      }
    });
    const children = [
      h("a", { class: "title", href: p.url, target: "_blank", rel: "noreferrer" }, [p.title || p.url])
    ];
    if (summary) children.push(summary);
    if (snippet) children.push(snippet);
    children.push(
      h("div", { class: "meta" }, [
        h("span", { class: "url" }, [p.url]),
        h("span", { class: "pill" }, [timeAgo(p.visitedAt)]),
        del
      ])
    );
    const row = h("div", { class: "hit" }, children);
    return row;
  }
  async function loadRecent(results) {
    try {
      const { pages } = await (await client()).recent({ limit: 30 });
      results.replaceChildren();
      if (!pages.length) {
        results.append(h("div", { class: "empty" }, ["No pages captured yet. Browse a few sites!"]));
        return;
      }
      for (const p of pages) results.append(renderHit(p, results));
    } catch (e) {
      results.replaceChildren(
        h("div", { class: "empty error" }, [e instanceof WtmApiError ? e.message : "Failed to load."])
      );
    }
  }
  async function runSearch(q, results) {
    if (!q) return loadRecent(results);
    try {
      const res = await (await client()).search(q, { limit: 30 });
      results.replaceChildren();
      if (!res.hits.length) {
        results.append(h("div", { class: "empty" }, [`No matches for \u201C${q}\u201D.`]));
        return;
      }
      for (const hit of res.hits) results.append(renderHit(hit, results));
    } catch (e) {
      results.replaceChildren(
        h("div", { class: "empty error" }, [e instanceof WtmApiError ? e.message : "Search failed."])
      );
    }
  }
  void renderApp();
})();
