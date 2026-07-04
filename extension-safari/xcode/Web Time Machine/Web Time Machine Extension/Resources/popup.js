"use strict";
(() => {
  // ../shared/src/index.ts
  var DEFAULT_BACKEND = "https://api.webtm.io";
  var RETENTION_MIN_DAYS = 1;
  var RETENTION_MAX_DAYS = 3650;
  function isValidRetentionDays(d) {
    return Number.isInteger(d) && d >= RETENTION_MIN_DAYS && d <= RETENTION_MAX_DAYS;
  }
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
    diagnostics: "/diagnostics",
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
        let err2 = { error: "http_error", message: `HTTP ${res.status}` };
        try {
          err2 = await res.json();
        } catch {
        }
        throw new WtmApiError(res.status, err2.error ?? "http_error", err2.message ?? `HTTP ${res.status}`);
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
    // --- diagnostics ---
    async reportDiagnostics(report) {
      await this.req("POST", Routes.diagnostics, report);
    }
  };

  // ../shared/src/format.ts
  var SEARCH_DEBOUNCE_MS = 220;
  function snippetHtml(s) {
    const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return esc.replaceAll("&lt;mark&gt;", "<mark>").replaceAll("&lt;/mark&gt;", "</mark>");
  }
  function chooseSubline(p) {
    if (p.snippet) return { kind: "snippet", value: p.snippet };
    if (p.summary) return { kind: "summary", value: p.summary };
    if (p.summaryStatus === "pending") return { kind: "pending" };
    return { kind: "none" };
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
  var DEFAULT_STATE = {
    baseUrl: DEFAULT_BACKEND,
    token: null,
    user: null,
    deviceId: null,
    deviceOwner: null,
    captureEnabled: true,
    lastSync: null,
    lastError: null,
    lastErrorAt: null,
    lastAutoReportAt: null
  };

  // ../node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/esm/browser.js
  var u8 = Uint8Array;
  var u16 = Uint16Array;
  var i32 = Int32Array;
  var fleb = new u8([
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    3,
    3,
    3,
    3,
    4,
    4,
    4,
    4,
    5,
    5,
    5,
    5,
    0,
    /* unused */
    0,
    0,
    /* impossible */
    0
  ]);
  var fdeb = new u8([
    0,
    0,
    0,
    0,
    1,
    1,
    2,
    2,
    3,
    3,
    4,
    4,
    5,
    5,
    6,
    6,
    7,
    7,
    8,
    8,
    9,
    9,
    10,
    10,
    11,
    11,
    12,
    12,
    13,
    13,
    /* unused */
    0,
    0
  ]);
  var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
  var freb = function(eb, start) {
    var b = new u16(31);
    for (var i = 0; i < 31; ++i) {
      b[i] = start += 1 << eb[i - 1];
    }
    var r = new i32(b[30]);
    for (var i = 1; i < 30; ++i) {
      for (var j = b[i]; j < b[i + 1]; ++j) {
        r[j] = j - b[i] << 5 | i;
      }
    }
    return { b, r };
  };
  var _a = freb(fleb, 2);
  var fl = _a.b;
  var revfl = _a.r;
  fl[28] = 258, revfl[258] = 28;
  var _b = freb(fdeb, 0);
  var fd = _b.b;
  var revfd = _b.r;
  var rev = new u16(32768);
  for (i = 0; i < 32768; ++i) {
    x = (i & 43690) >> 1 | (i & 21845) << 1;
    x = (x & 52428) >> 2 | (x & 13107) << 2;
    x = (x & 61680) >> 4 | (x & 3855) << 4;
    rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
  }
  var x;
  var i;
  var hMap = function(cd, mb, r) {
    var s = cd.length;
    var i = 0;
    var l = new u16(mb);
    for (; i < s; ++i) {
      if (cd[i])
        ++l[cd[i] - 1];
    }
    var le = new u16(mb);
    for (i = 1; i < mb; ++i) {
      le[i] = le[i - 1] + l[i - 1] << 1;
    }
    var co;
    if (r) {
      co = new u16(1 << mb);
      var rvb = 15 - mb;
      for (i = 0; i < s; ++i) {
        if (cd[i]) {
          var sv = i << 4 | cd[i];
          var r_1 = mb - cd[i];
          var v = le[cd[i] - 1]++ << r_1;
          for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
            co[rev[v] >> rvb] = sv;
          }
        }
      }
    } else {
      co = new u16(s);
      for (i = 0; i < s; ++i) {
        if (cd[i]) {
          co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
        }
      }
    }
    return co;
  };
  var flt = new u8(288);
  for (i = 0; i < 144; ++i)
    flt[i] = 8;
  var i;
  for (i = 144; i < 256; ++i)
    flt[i] = 9;
  var i;
  for (i = 256; i < 280; ++i)
    flt[i] = 7;
  var i;
  for (i = 280; i < 288; ++i)
    flt[i] = 8;
  var i;
  var fdt = new u8(32);
  for (i = 0; i < 32; ++i)
    fdt[i] = 5;
  var i;
  var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
  var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
  var max = function(a) {
    var m = a[0];
    for (var i = 1; i < a.length; ++i) {
      if (a[i] > m)
        m = a[i];
    }
    return m;
  };
  var bits = function(d, p, m) {
    var o = p / 8 | 0;
    return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
  };
  var bits16 = function(d, p) {
    var o = p / 8 | 0;
    return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
  };
  var shft = function(p) {
    return (p + 7) / 8 | 0;
  };
  var slc = function(v, s, e) {
    if (s == null || s < 0)
      s = 0;
    if (e == null || e > v.length)
      e = v.length;
    return new u8(v.subarray(s, e));
  };
  var ec = [
    "unexpected EOF",
    "invalid block type",
    "invalid length/literal",
    "invalid distance",
    "stream finished",
    "no stream handler",
    ,
    // determined by compression function
    "no callback",
    "invalid UTF-8 data",
    "extra field too long",
    "date not in range 1980-2099",
    "filename too long",
    "stream finishing",
    "invalid zip data"
    // determined by unknown compression method
  ];
  var err = function(ind, msg, nt) {
    var e = new Error(msg || ec[ind]);
    e.code = ind;
    if (Error.captureStackTrace)
      Error.captureStackTrace(e, err);
    if (!nt)
      throw e;
    return e;
  };
  var inflt = function(dat, st, buf, dict) {
    var sl = dat.length, dl = dict ? dict.length : 0;
    if (!sl || st.f && !st.l)
      return buf || new u8(0);
    var noBuf = !buf;
    var resize = noBuf || st.i != 2;
    var noSt = st.i;
    if (noBuf)
      buf = new u8(sl * 3);
    var cbuf = function(l2) {
      var bl = buf.length;
      if (l2 > bl) {
        var nbuf = new u8(Math.max(bl * 2, l2));
        nbuf.set(buf);
        buf = nbuf;
      }
    };
    var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
    var tbts = sl * 8;
    do {
      if (!lm) {
        final = bits(dat, pos, 1);
        var type = bits(dat, pos + 1, 3);
        pos += 3;
        if (!type) {
          var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
          if (t > sl) {
            if (noSt)
              err(0);
            break;
          }
          if (resize)
            cbuf(bt + l);
          buf.set(dat.subarray(s, t), bt);
          st.b = bt += l, st.p = pos = t * 8, st.f = final;
          continue;
        } else if (type == 1)
          lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
        else if (type == 2) {
          var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
          var tl = hLit + bits(dat, pos + 5, 31) + 1;
          pos += 14;
          var ldt = new u8(tl);
          var clt = new u8(19);
          for (var i = 0; i < hcLen; ++i) {
            clt[clim[i]] = bits(dat, pos + i * 3, 7);
          }
          pos += hcLen * 3;
          var clb = max(clt), clbmsk = (1 << clb) - 1;
          var clm = hMap(clt, clb, 1);
          for (var i = 0; i < tl; ) {
            var r = clm[bits(dat, pos, clbmsk)];
            pos += r & 15;
            var s = r >> 4;
            if (s < 16) {
              ldt[i++] = s;
            } else {
              var c = 0, n = 0;
              if (s == 16)
                n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
              else if (s == 17)
                n = 3 + bits(dat, pos, 7), pos += 3;
              else if (s == 18)
                n = 11 + bits(dat, pos, 127), pos += 7;
              while (n--)
                ldt[i++] = c;
            }
          }
          var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
          lbt = max(lt);
          dbt = max(dt);
          lm = hMap(lt, lbt, 1);
          dm = hMap(dt, dbt, 1);
        } else
          err(1);
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
      }
      if (resize)
        cbuf(bt + 131072);
      var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
      var lpos = pos;
      for (; ; lpos = pos) {
        var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
        pos += c & 15;
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (!c)
          err(2);
        if (sym < 256)
          buf[bt++] = sym;
        else if (sym == 256) {
          lpos = pos, lm = null;
          break;
        } else {
          var add = sym - 254;
          if (sym > 264) {
            var i = sym - 257, b = fleb[i];
            add = bits(dat, pos, (1 << b) - 1) + fl[i];
            pos += b;
          }
          var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
          if (!d)
            err(3);
          pos += d & 15;
          var dt = fd[dsym];
          if (dsym > 3) {
            var b = fdeb[dsym];
            dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
          }
          if (pos > tbts) {
            if (noSt)
              err(0);
            break;
          }
          if (resize)
            cbuf(bt + 131072);
          var end = bt + add;
          if (bt < dt) {
            var shift = dl - dt, dend = Math.min(dt, end);
            if (shift + bt < 0)
              err(3);
            for (; bt < dend; ++bt)
              buf[bt] = dict[shift + bt];
          }
          for (; bt < end; ++bt)
            buf[bt] = buf[bt - dt];
        }
      }
      st.l = lm, st.p = lpos, st.b = bt, st.f = final;
      if (lm)
        final = 1, st.m = lbt, st.d = dm, st.n = dbt;
    } while (!final);
    return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
  };
  var et = /* @__PURE__ */ new u8(0);
  var gzs = function(d) {
    if (d[0] != 31 || d[1] != 139 || d[2] != 8)
      err(6, "invalid gzip data");
    var flg = d[3];
    var st = 10;
    if (flg & 4)
      st += (d[10] | d[11] << 8) + 2;
    for (var zs = (flg >> 3 & 1) + (flg >> 4 & 1); zs > 0; zs -= !d[st++])
      ;
    return st + (flg & 2);
  };
  var gzl = function(d) {
    var l = d.length;
    return (d[l - 4] | d[l - 3] << 8 | d[l - 2] << 16 | d[l - 1] << 24) >>> 0;
  };
  function gunzipSync(data, opts) {
    var st = gzs(data);
    if (st + 8 > data.length)
      err(6, "invalid gzip data");
    return inflt(data.subarray(st, -8), { i: 2 }, opts && opts.out || new u8(gzl(data)), opts && opts.dictionary);
  }
  var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
  var tds = 0;
  try {
    td.decode(et, { stream: true });
    tds = 1;
  } catch (e) {
  }
  var dutf8 = function(d) {
    for (var r = "", i = 0; ; ) {
      var c = d[i++];
      var eb = (c > 127) + (c > 223) + (c > 239);
      if (i + eb > d.length)
        return { s: r, r: slc(d, i - 1) };
      if (!eb)
        r += String.fromCharCode(c);
      else if (eb == 3) {
        c = ((c & 15) << 18 | (d[i++] & 63) << 12 | (d[i++] & 63) << 6 | d[i++] & 63) - 65536, r += String.fromCharCode(55296 | c >> 10, 56320 | c & 1023);
      } else if (eb & 1)
        r += String.fromCharCode((c & 31) << 6 | d[i++] & 63);
      else
        r += String.fromCharCode((c & 15) << 12 | (d[i++] & 63) << 6 | d[i++] & 63);
    }
  };
  function strFromU8(dat, latin1) {
    if (latin1) {
      var r = "";
      for (var i = 0; i < dat.length; i += 16384)
        r += String.fromCharCode.apply(null, dat.subarray(i, i + 16384));
      return r;
    } else if (td) {
      return td.decode(dat);
    } else {
      var _a2 = dutf8(dat), s = _a2.s, r = _a2.r;
      if (r.length)
        err(8);
      return s;
    }
  }

  // ../extension-chrome/src/gzip.ts
  function gunzipFromB64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return strFromU8(gunzipSync(bytes));
  }

  // ../extension-chrome/src/storage.ts
  var STATE_KEY = "wtm:state";
  var QUEUE_KEY = "wtm:queue";
  var CEILING_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
  var storageLock = Promise.resolve();
  async function getState() {
    const o = await chrome.storage.local.get(STATE_KEY);
    return { ...DEFAULT_STATE, ...o[STATE_KEY] ?? {} };
  }
  async function readQueueInternal() {
    const o = await chrome.storage.local.get(QUEUE_KEY);
    const raw = o[QUEUE_KEY];
    if (raw == null) return { pages: [], format: "absent" };
    if (Array.isArray(raw)) return { pages: raw, format: "plain" };
    const env = raw;
    if (typeof env === "object" && (env.v === 1 || env.v === 2) && typeof env.gz === "string") {
      try {
        return { pages: JSON.parse(gunzipFromB64(env.gz)), format: env.v === 2 ? "v2" : "v1" };
      } catch {
        return { pages: [], format: "corrupt", raw };
      }
    }
    return { pages: [], format: "corrupt", raw };
  }
  async function getQueueCount() {
    const o = await chrome.storage.local.get(QUEUE_KEY);
    const raw = o[QUEUE_KEY];
    if (raw == null) return 0;
    if (Array.isArray(raw)) return raw.length;
    if (raw.v === 2 && typeof raw.n === "number") return raw.n;
    return (await readQueueInternal()).pages.length;
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
  async function sendBg(msg) {
    const attempt = () => chrome.runtime.sendMessage(msg);
    try {
      return await attempt();
    } catch {
      await new Promise((r) => setTimeout(r, 500));
      return attempt();
    }
  }
  async function mutate(patch, opts = {}) {
    const resp = await sendBg({
      type: "setState",
      patch,
      thenFlush: opts.thenFlush
    });
    if (!resp?.ok || !resp.state) throw new Error(resp?.error ?? "Couldn't save \u2014 try again.");
    return resp.state;
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
    const err2 = h("div", { class: "error" }, [errorMsg ?? ""]);
    const loginBtn = h("button", {}, ["Log in"]);
    const registerBtn = h("button", { class: "secondary" }, ["Create account"]);
    async function submit(register) {
      err2.textContent = "";
      const baseUrl = urlField.value.trim() || DEFAULT_BACKEND;
      const email = emailField.value.trim();
      const password = passField.value;
      if (!email || !password) {
        err2.textContent = "Email and password required.";
        return;
      }
      loginBtn.disabled = registerBtn.disabled = true;
      try {
        const c = new WtmClient({ baseUrl });
        const res = register ? await c.register({ email, password }) : await c.login({ email, password });
        await mutate(
          { baseUrl, token: res.token, user: res.user, lastError: null, lastErrorAt: null },
          { thenFlush: true }
        );
        await renderApp();
      } catch (e) {
        err2.textContent = e instanceof WtmApiError ? e.message : `Could not reach ${baseUrl}`;
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
        err2
      ])
    );
  }
  var searchTimer = null;
  async function renderStatus(container) {
    const st = await getState();
    const queued = await getQueueCount();
    const children = [
      h("span", {}, [h("b", {}, [String(queued)]), " queued"]),
      " \xB7 ",
      h("span", {}, [st.lastSync ? `synced ${timeAgo(st.lastSync)}` : "not synced yet"])
    ];
    const ERROR_TTL_MS = 15 * 6e4;
    if (st.lastError && st.lastErrorAt && Date.now() - st.lastErrorAt < ERROR_TTL_MS) {
      const cls = /storage was full/i.test(st.lastError) ? "hint" : "error";
      children.push(h("div", { class: cls }, [`${st.lastError} (${timeAgo(st.lastErrorAt)})`]));
    }
    container.replaceChildren(...children);
  }
  async function renderApp() {
    const st = await getState();
    if (!st.token || !st.user) return renderAuth();
    app.replaceChildren();
    const captureToggle = h("input", { type: "checkbox" });
    captureToggle.checked = st.captureEnabled;
    captureToggle.addEventListener("change", async () => {
      const wanted = captureToggle.checked;
      try {
        await mutate({ captureEnabled: wanted });
      } catch {
        captureToggle.checked = !wanted;
      }
    });
    const logout = h("button", { class: "link" }, ["Log out"]);
    logout.addEventListener("click", async () => {
      try {
        await mutate({ token: null, user: null });
        await renderAuth();
      } catch {
        logout.textContent = "Log out failed \u2014 retry";
      }
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
    const status = h("div", { class: "section status" });
    app.append(status);
    await renderStatus(status);
    void chrome.runtime.sendMessage({ type: "flushNow" }).catch(() => null).then(() => renderStatus(status));
    app.append(await buildSettings(st));
    const search = h("input", { type: "search", placeholder: "Search your history\u2026" });
    app.append(h("div", { class: "section" }, [search]));
    const results = h("div", { class: "results" }, [h("div", { class: "empty" }, ["Loading recent pages\u2026"])]);
    app.append(results);
    search.addEventListener("input", () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => void runSearch(search.value.trim(), results), SEARCH_DEBOUNCE_MS);
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
        await mutate({ user: u });
      } catch {
        filterCb.checked = !filterCb.checked;
      } finally {
        filterCb.disabled = false;
      }
    });
    const daysInput = h("input", {
      type: "number",
      min: String(RETENTION_MIN_DAYS),
      max: String(RETENTION_MAX_DAYS),
      value: String(st.user?.retentionDays ?? 90)
    });
    const daysBtn = h("button", { class: "secondary tiny" }, ["Save"]);
    const daysMsg = h("span", { class: "hint" }, []);
    daysBtn.addEventListener("click", async () => {
      const d = parseInt(daysInput.value, 10);
      if (!isValidRetentionDays(d)) {
        daysMsg.textContent = `${RETENTION_MIN_DAYS}\u2013${RETENTION_MAX_DAYS} days`;
        return;
      }
      daysBtn.disabled = true;
      daysMsg.textContent = "";
      try {
        const u = await (await client()).updateSettings({ retentionDays: d });
        await mutate({ user: u });
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
    const reportMsg = h("span", { class: "hint" }, []);
    const reportBtn = h("button", { class: "secondary tiny" }, ["Report sync issue"]);
    const clearBtn = h("button", { class: "secondary tiny" }, ["Clear stuck queue"]);
    reportBtn.addEventListener("click", async () => {
      reportBtn.disabled = true;
      reportMsg.textContent = "Sending\u2026";
      try {
        const resp = await sendBg({ type: "reportDiagnostics" });
        if (!resp?.ok) throw new Error(resp?.error ?? "failed");
        reportMsg.textContent = "Sent \u2014 thanks, we'll take a look.";
      } catch {
        reportMsg.textContent = "Couldn't send (offline?)";
      } finally {
        reportBtn.disabled = false;
      }
    });
    clearBtn.addEventListener("click", async () => {
      const queued = await getQueueCount();
      if (queued && !confirm(`Discard ${queued} unsynced page(s) from this device? This can't be undone.`)) {
        return;
      }
      clearBtn.disabled = true;
      reportMsg.textContent = "";
      try {
        const resp = await sendBg({ type: "clearQueue" });
        if (!resp?.ok) throw new Error(resp?.error ?? "failed");
        reportMsg.textContent = "Queue cleared.";
      } catch {
        reportMsg.textContent = "Couldn't clear the queue.";
      } finally {
        clearBtn.disabled = false;
      }
    });
    children.push(
      h("div", { class: "field" }, [
        h("label", {}, ["Sync stuck?"]),
        h("div", { class: "row" }, [reportBtn, clearBtn]),
        reportMsg
      ])
    );
    return h("details", { class: "section settings" }, children);
  }
  function renderHit(p, results) {
    const chosen = chooseSubline({ ..."snippet" in p && { snippet: p.snippet }, summary: p.summary, summaryStatus: p.summaryStatus });
    const sub = chosen.kind === "snippet" ? h("div", { class: "snippet", html: snippetHtml(chosen.value) }) : chosen.kind === "summary" ? h("div", { class: "summary" }, [chosen.value]) : chosen.kind === "pending" ? h("div", { class: "summary hint" }, ["Summarizing\u2026"]) : null;
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
    if (sub) children.push(sub);
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
