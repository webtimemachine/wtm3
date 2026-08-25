"use strict";
(() => {
  // ../shared/src/index.ts
  var DEFAULT_BACKEND = "https://api.webtm.io";
  var Routes = {
    register: "/auth/register",
    login: "/auth/login",
    logout: "/auth/logout",
    logoutEverywhere: "/auth/logout-everywhere",
    changePassword: "/auth/password",
    requestPasswordReset: "/auth/password-reset/request",
    confirmPasswordReset: "/auth/password-reset/confirm",
    extensionAuthStart: "/auth/extension/start",
    extensionAuthRequest: "/auth/extension/request",
    extensionAuthApprove: "/auth/extension/approve",
    extensionAuthToken: "/auth/extension/token",
    account: "/account",
    me: "/auth/me",
    settings: "/settings",
    nodes: "/nodes",
    node: (id) => `/nodes/${id}`,
    syncPush: "/sync/push",
    search: "/search",
    suggest: "/suggest",
    indexSnapshot: "/index-snapshot",
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
    async req(method, path, body, signal) {
      const headers = {};
      if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
      if (body !== void 0) headers["Content-Type"] = "application/json";
      const res = await this.f(`${this.baseUrl}${path}`, {
        method,
        headers,
        signal,
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
    async logout() {
      await this.req("POST", Routes.logout);
    }
    async logoutEverywhere() {
      await this.req("POST", Routes.logoutEverywhere);
    }
    changePassword(req) {
      return this.req("POST", Routes.changePassword, req);
    }
    async requestPasswordReset(email) {
      await this.req("POST", Routes.requestPasswordReset, { email });
    }
    async confirmPasswordReset(req) {
      await this.req("POST", Routes.confirmPasswordReset, req);
    }
    startExtensionAuth(req) {
      return this.req("POST", Routes.extensionAuthStart, req);
    }
    extensionAuthRequest(requestId) {
      return this.req("POST", Routes.extensionAuthRequest, { requestId });
    }
    async approveExtensionAuth(requestId) {
      await this.req("POST", Routes.extensionAuthApprove, { requestId });
    }
    exchangeExtensionAuth(req) {
      return this.req("POST", Routes.extensionAuthToken, req);
    }
    async deleteAccount(req) {
      await this.req("DELETE", Routes.account, req);
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
    // --- search & pages ---
    search(query, opts = {}) {
      const p = new URLSearchParams({ q: query });
      if (opts.limit != null) p.set("limit", String(opts.limit));
      if (opts.offset != null) p.set("offset", String(opts.offset));
      if (opts.from != null) p.set("from", String(opts.from));
      if (opts.to != null) p.set("to", String(opts.to));
      if (opts.site?.trim()) p.set("site", opts.site.trim());
      if (opts.sort) p.set("sort", opts.sort);
      return this.req("GET", `${Routes.search}?${p.toString()}`);
    }
    suggest(query, limit = 6, signal) {
      const p = new URLSearchParams({ q: query, limit: String(limit) });
      return this.req("GET", `${Routes.suggest}?${p.toString()}`, void 0, signal);
    }
    indexSnapshot(limit = 2e3) {
      const p = new URLSearchParams({ limit: String(limit) });
      return this.req("GET", `${Routes.indexSnapshot}?${p.toString()}`);
    }
    recent(opts = {}) {
      const p = new URLSearchParams();
      if (opts.limit != null) p.set("limit", String(opts.limit));
      if (opts.before != null) p.set("before", String(opts.before));
      const qs = p.toString();
      return this.req("GET", qs ? `${Routes.recent}?${qs}` : Routes.recent);
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

  // ../shared/src/auth.ts
  function toBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  async function createPkcePair() {
    const verifier = toBase64Url(
      crypto.getRandomValues(new Uint8Array(32))
    );
    return { verifier, challenge: await pkceChallenge(verifier) };
  }
  async function pkceChallenge(verifier) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier)
    );
    return toBase64Url(new Uint8Array(digest));
  }

  // ../shared/src/format.ts
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
  var injectedPlatform = true ? "safari-ios" : "chrome";
  var PLATFORM = injectedPlatform === "firefox-android" || injectedPlatform === "safari-ios" ? injectedPlatform : "chrome";
  var DEFAULT_STATE = {
    baseUrl: DEFAULT_BACKEND,
    token: null,
    tokenScope: null,
    assistToken: null,
    assistEnabled: false,
    lastAssistError: null,
    user: null,
    deviceId: null,
    deviceOwner: null,
    captureEnabled: true,
    searchRouterEnabled: false,
    lastSync: null,
    lastError: null,
    lastErrorAt: null,
    pendingConnection: null,
    pendingAssistConnection: null
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
  var DASHBOARD_URL = "https://webtm.io/";
  var SEARCH_URL = "https://webtm.io/search";
  var NATIVE_APP_ID = "com.ttt246llc.wtm";
  function h(tag, attrs = {}, children = []) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null) continue;
      if (key === "class") element.className = value;
      else if (key === "html") element.innerHTML = value;
      else element.setAttribute(key, value);
    }
    for (const child of children) element.append(child);
    return element;
  }
  async function client() {
    const state = await getState();
    return new WtmClient({ baseUrl: state.baseUrl, token: state.token });
  }
  async function sendBg(message) {
    const attempt = () => chrome.runtime.sendMessage(message);
    try {
      return await attempt();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return attempt();
    }
  }
  async function mutate(patch, opts = {}) {
    const response = await sendBg({
      type: "setState",
      patch,
      thenFlush: opts.thenFlush
    });
    if (!response?.ok || !response.state) {
      throw new Error(response?.error ?? "Couldn't save \u2014 try again.");
    }
    return response.state;
  }
  function extensionClientName() {
    if (PLATFORM === "safari-ios") return "Safari extension";
    if (PLATFORM === "firefox-android") return "Firefox extension";
    return "Chrome extension";
  }
  async function notifyNative(message) {
    if (PLATFORM !== "safari-ios") return null;
    try {
      return await chrome.runtime.sendNativeMessage(
        NATIVE_APP_ID,
        message
      );
    } catch {
      return null;
    }
  }
  function connectionUrl(pending) {
    const url = new URL(DASHBOARD_URL);
    url.searchParams.set("connect", pending.requestId);
    if (pending.baseUrl.replace(/\/+$/, "") !== DEFAULT_BACKEND) {
      url.searchParams.set("backend", pending.baseUrl);
    }
    return url.toString();
  }
  function brandHeader() {
    return h("header", {}, [
      h("span", {
        class: "brand",
        html: 'Web Time <span class="dot">Machine</span>'
      })
    ]);
  }
  async function renderAuth(errorMessage) {
    let state = await getState();
    const pending = state.pendingConnection;
    if (pending && pending.expiresAt <= Date.now()) {
      state = await mutate({ pendingConnection: null });
      errorMessage = "That connection request expired. Start a new one.";
    }
    if (!state.pendingConnection) {
      renderConnectStart(state, errorMessage);
      return;
    }
    try {
      const response = await new WtmClient({
        baseUrl: state.pendingConnection.baseUrl
      }).exchangeExtensionAuth({
        requestId: state.pendingConnection.requestId,
        codeVerifier: state.pendingConnection.codeVerifier
      });
      if (response.status === "connected") {
        if (response.scope !== "capture") {
          throw new Error("The server returned the wrong extension permission.");
        }
        await mutate(
          {
            baseUrl: state.pendingConnection.baseUrl,
            token: response.token,
            tokenScope: "capture",
            user: response.user,
            pendingConnection: null,
            lastError: null,
            lastErrorAt: null
          },
          { thenFlush: true }
        );
        await renderApp();
        return;
      }
      renderPending(state.pendingConnection, errorMessage);
    } catch (caught) {
      if (caught instanceof WtmApiError && (caught.status === 404 || caught.status === 410)) {
        const next = await mutate({ pendingConnection: null });
        renderConnectStart(next, caught.message);
        return;
      }
      renderPending(
        state.pendingConnection,
        caught instanceof WtmApiError ? caught.message : `Could not reach ${state.pendingConnection.baseUrl}`
      );
    }
  }
  function renderConnectStart(state, errorMessage) {
    app.replaceChildren();
    const backend = h("input", {
      type: "url",
      id: "backend",
      name: "backend",
      autocomplete: "url",
      required: "",
      value: state.baseUrl || DEFAULT_BACKEND
    });
    const submit = h("button", { type: "submit" }, [
      "Connect with webtm.io"
    ]);
    const error = h("div", { class: "error", role: "alert" }, [
      errorMessage ?? ""
    ]);
    const form = h("form", { class: "section connect-form" }, [
      h("p", { class: "connect-title" }, ["Connect this browser"]),
      h("p", { class: "connect-copy" }, [
        "Sign in once on webtm.io. Your password never enters the extension."
      ]),
      h("div", { class: "field" }, [
        h("label", { for: "backend" }, ["Backend URL"]),
        backend
      ]),
      submit,
      error
    ]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      submit.disabled = true;
      const baseUrl = backend.value.trim().replace(/\/+$/, "") || DEFAULT_BACKEND;
      try {
        const { verifier, challenge } = await createPkcePair();
        const response = await new WtmClient({ baseUrl }).startExtensionAuth({
          codeChallenge: challenge,
          client: extensionClientName(),
          scope: "capture"
        });
        const pending = {
          requestId: response.requestId,
          codeVerifier: verifier,
          expiresAt: response.expiresAt,
          baseUrl,
          scope: "capture"
        };
        await mutate({ baseUrl, pendingConnection: pending });
        renderPending(pending);
        try {
          await chrome.tabs.create({ url: connectionUrl(pending) });
        } catch {
          renderPending(
            pending,
            "Couldn\u2019t open a tab automatically. Use Open webtm.io below."
          );
        }
      } catch (caught) {
        error.textContent = caught instanceof WtmApiError ? caught.message : `Could not reach ${baseUrl}`;
        submit.disabled = false;
      }
    });
    app.append(brandHeader(), form);
  }
  function renderPending(pending, errorMessage) {
    app.replaceChildren();
    const check = h("button", { type: "button" }, [
      "Check connection"
    ]);
    check.addEventListener("click", () => {
      check.disabled = true;
      void renderAuth();
    });
    const restart = h(
      "button",
      { type: "button", class: "secondary" },
      ["Start over"]
    );
    restart.addEventListener("click", async () => {
      restart.disabled = true;
      await mutate({ pendingConnection: null });
      await renderAuth();
    });
    app.append(
      brandHeader(),
      h("div", { class: "section connect-pending" }, [
        h("p", { class: "connect-title" }, ["Finish on webtm.io"]),
        h("p", { class: "connect-copy" }, [
          "Sign in and approve this browser. Then reopen this popup or check the connection here."
        ]),
        h(
          "a",
          {
            class: "primary-action",
            href: connectionUrl(pending),
            target: "_blank",
            rel: "noreferrer"
          },
          ["Open webtm.io"]
        ),
        h("div", { class: "row connect-actions" }, [check, restart]),
        h("div", { class: "error", role: "alert" }, [errorMessage ?? ""])
      ])
    );
  }
  async function renderStatus(container) {
    const state = await getState();
    const queued = await getQueueCount();
    const children = [
      h("span", {}, [h("b", {}, [String(queued)]), " queued"]),
      " \xB7 ",
      h("span", {}, [
        state.lastSync ? `synced ${timeAgo(state.lastSync)}` : "not synced yet"
      ])
    ];
    const errorTtlMs = 15 * 6e4;
    if (state.lastError && state.lastErrorAt && Date.now() - state.lastErrorAt < errorTtlMs) {
      const className = /storage was full/i.test(state.lastError) ? "hint" : "error";
      children.push(
        h("div", { class: className }, [
          `${state.lastError} (${timeAgo(state.lastErrorAt)})`
        ])
      );
    }
    container.replaceChildren(...children);
  }
  async function renderApp() {
    let state = await getState();
    if (state.token && state.user && state.tokenScope !== "capture") {
      await mutate({ token: null, tokenScope: null, user: null });
      await renderAuth();
      return;
    }
    if (!state.token || !state.user) {
      await renderAuth();
      return;
    }
    state = await pollAssistConnection(state);
    if (!state.user) {
      await renderAuth();
      return;
    }
    app.replaceChildren();
    const captureToggle = h("input", {
      type: "checkbox"
    });
    captureToggle.checked = state.captureEnabled;
    captureToggle.addEventListener("change", async () => {
      const wanted = captureToggle.checked;
      try {
        await mutate({ captureEnabled: wanted });
      } catch {
        captureToggle.checked = !wanted;
      }
    });
    const disconnect = h("button", { type: "button", class: "link" }, [
      "Disconnect"
    ]);
    disconnect.addEventListener("click", async () => {
      disconnect.disabled = true;
      try {
        await (await client()).logout();
      } catch {
      }
      if (state.assistToken) {
        try {
          await new WtmClient({ baseUrl: state.baseUrl, token: state.assistToken }).logout();
        } catch {
        }
      }
      await notifyNative({ type: "disableSearchAssist" });
      try {
        await mutate({
          token: null,
          tokenScope: null,
          assistToken: null,
          assistEnabled: false,
          lastAssistError: null,
          user: null,
          pendingConnection: null,
          pendingAssistConnection: null
        });
        await renderAuth();
      } catch {
        disconnect.disabled = false;
        disconnect.textContent = "Disconnect failed \u2014 retry";
      }
    });
    app.append(
      h("header", {}, [
        h("span", { class: "brand", html: 'WTM<span class="dot">.</span>' }),
        h("span", { class: "email" }, [state.user.email]),
        h("span", { class: "spacer" }),
        h("label", { class: "toggle", title: "Capture pages" }, [
          captureToggle,
          "capture"
        ]),
        disconnect
      ])
    );
    const status = h("div", { class: "section status" });
    app.append(status);
    await renderStatus(status);
    void chrome.runtime.sendMessage({ type: "flushNow" }).catch(() => null).then(() => renderStatus(status));
    app.append(
      PLATFORM === "firefox-android" ? h("div", { class: "section search-launcher" }, [
        h("a", {
          class: "primary-action",
          href: DASHBOARD_URL,
          target: "_blank",
          rel: "noreferrer"
        }, ["Search your history"]),
        h("span", { class: "hint" }, ["Opens webtm.io"])
      ]) : buildSearchAssist(state),
      buildDiagnostics()
    );
  }
  async function pollAssistConnection(state) {
    const pending = state.pendingAssistConnection;
    if (!pending) {
      if (state.assistEnabled && state.assistToken) {
        const native = await notifyNative({
          type: "configureSearchAssist",
          token: state.assistToken,
          baseUrl: state.baseUrl,
          force: false
        });
        if (native?.error === "disabled_in_app") {
          try {
            await new WtmClient({ baseUrl: state.baseUrl, token: state.assistToken }).logout();
          } catch {
          }
          return mutate({
            assistToken: null,
            assistEnabled: false,
            searchRouterEnabled: false,
            lastAssistError: "Search Assist was disabled from the iOS app."
          });
        }
      }
      return state;
    }
    if (pending.expiresAt <= Date.now()) {
      return mutate({ pendingAssistConnection: null });
    }
    try {
      const response = await new WtmClient({ baseUrl: pending.baseUrl }).exchangeExtensionAuth({
        requestId: pending.requestId,
        codeVerifier: pending.codeVerifier
      });
      if (response.status !== "connected") return state;
      if (response.scope !== "assist") {
        return mutate({
          pendingAssistConnection: null,
          lastAssistError: "The server returned the wrong Search Assist permission."
        });
      }
      if (!state.user || response.user.id !== state.user.id) {
        try {
          await new WtmClient({ baseUrl: pending.baseUrl, token: response.token }).logout();
        } catch {
        }
        return mutate({
          pendingAssistConnection: null,
          lastAssistError: "Search Assist was approved for a different account. Sign in to the same account on webtm.io and try again."
        });
      }
      const next = await mutate({
        assistToken: response.token,
        assistEnabled: true,
        pendingAssistConnection: null,
        lastAssistError: null
      });
      await notifyNative({
        type: "configureSearchAssist",
        token: response.token,
        baseUrl: pending.baseUrl,
        force: true
      });
      return next;
    } catch (caught) {
      if (caught instanceof WtmApiError && (caught.status === 404 || caught.status === 410)) {
        return mutate({ pendingAssistConnection: null });
      }
      return state;
    }
  }
  function buildSearchAssist(state) {
    const section = h("div", { class: "section search-assist" });
    section.append(
      h("div", { class: "row section-heading" }, [
        h("b", {}, ["Search Assist"]),
        h("span", { class: `assist-state ${state.assistEnabled ? "on" : ""}` }, [
          state.assistEnabled ? "On" : "Off"
        ])
      ])
    );
    const pending = state.pendingAssistConnection;
    if (pending) {
      const check = h("button", { type: "button" }, ["Check approval"]);
      check.addEventListener("click", () => {
        check.disabled = true;
        void renderApp();
      });
      const cancel = h("button", { type: "button", class: "secondary" }, ["Cancel"]);
      cancel.addEventListener("click", async () => {
        await mutate({ pendingAssistConnection: null });
        await renderApp();
      });
      section.append(
        h("p", { class: "hint" }, ["Approve read-only history suggestions on webtm.io."]),
        h("a", { class: "primary-action", href: connectionUrl(pending), target: "_blank", rel: "noreferrer" }, ["Open approval"]),
        h("div", { class: "row" }, [check, cancel])
      );
      return section;
    }
    if (!state.assistEnabled || !state.assistToken) {
      const enable = h("button", { type: "button" }, ["Enable Search Assist"]);
      const message = h("div", { class: "error", role: "alert" });
      enable.addEventListener("click", async () => {
        enable.disabled = true;
        message.textContent = "";
        try {
          const { verifier, challenge } = await createPkcePair();
          const response = await new WtmClient({ baseUrl: state.baseUrl }).startExtensionAuth({
            codeChallenge: challenge,
            client: extensionClientName(),
            scope: "assist"
          });
          const next = {
            requestId: response.requestId,
            codeVerifier: verifier,
            expiresAt: response.expiresAt,
            baseUrl: state.baseUrl,
            scope: "assist"
          };
          await mutate({ pendingAssistConnection: next, lastAssistError: null });
          await chrome.tabs.create({ url: connectionUrl(next) });
          await renderApp();
        } catch (caught) {
          message.textContent = caught instanceof WtmApiError ? caught.message : "Could not start Search Assist approval.";
          enable.disabled = false;
        }
      });
      section.append(
        h("p", { class: "hint" }, [
          PLATFORM === "safari-ios" ? "Find saved pages in this popup and iOS Spotlight. Safari controls address-bar ranking." : "Type wtm and a space in Chrome\u2019s address bar to search your history."
        ]),
        enable,
        message,
        state.lastAssistError ? h("div", { class: "error", role: "alert" }, [state.lastAssistError]) : ""
      );
      return section;
    }
    const search = h("input", {
      type: "search",
      placeholder: "Search saved pages\u2026",
      autocomplete: "off"
    });
    const results = h("div", { class: "assist-results" });
    let timer = null;
    let generation = 0;
    search.addEventListener("input", () => {
      if (timer) clearTimeout(timer);
      const query = search.value.trim();
      const current = ++generation;
      if (query.length < 2) {
        results.replaceChildren();
        return;
      }
      timer = setTimeout(async () => {
        try {
          const response = await new WtmClient({ baseUrl: state.baseUrl, token: state.assistToken }).suggest(query, 6);
          if (current !== generation) return;
          results.replaceChildren(
            ...response.suggestions.map(
              (item) => h("a", { class: "assist-result", href: item.url, target: "_blank", rel: "noreferrer" }, [
                h("span", { class: "assist-title" }, [item.title || item.url]),
                h("span", { class: "hint" }, [new URL(item.url).hostname])
              ])
            )
          );
        } catch {
          if (current === generation) results.replaceChildren(h("span", { class: "error" }, ["Search unavailable."]));
        }
      }, 140);
    });
    const openFull = h("a", {
      class: "secondary-action",
      href: SEARCH_URL,
      target: "_blank",
      rel: "noreferrer"
    }, ["Full history search"]);
    const disable = h("button", { type: "button", class: "link danger" }, ["Disable"]);
    disable.addEventListener("click", async () => {
      disable.disabled = true;
      try {
        await new WtmClient({ baseUrl: state.baseUrl, token: state.assistToken }).logout();
      } catch {
      }
      await notifyNative({ type: "disableSearchAssist" });
      await mutate({
        assistToken: null,
        assistEnabled: false,
        lastAssistError: null,
        pendingAssistConnection: null,
        searchRouterEnabled: false
      });
      await renderApp();
    });
    section.append(search, results, h("div", { class: "row assist-actions" }, [openFull, disable]));
    if (PLATFORM === "safari-ios") {
      const router = h("input", { type: "checkbox" });
      router.checked = state.searchRouterEnabled;
      router.addEventListener("change", async () => {
        const wanted = router.checked;
        try {
          await mutate({ searchRouterEnabled: wanted });
        } catch {
          router.checked = !wanted;
        }
      });
      section.append(
        h("label", { class: "router-toggle" }, [router, h("span", {}, [
          "Route explicit ",
          h("code", {}, ["wtm "]),
          " or ",
          h("code", {}, ["!w "]),
          " searches"
        ])]),
        h("p", { class: "hint" }, ["Ordinary Safari searches and autocomplete stay unchanged."])
      );
    }
    return section;
  }
  function buildDiagnostics() {
    const message = h("span", { class: "hint" });
    const clear = h(
      "button",
      { type: "button", class: "secondary tiny" },
      ["Clear stuck queue"]
    );
    clear.addEventListener("click", async () => {
      const queued = await getQueueCount();
      if (queued && !confirm(
        `Discard ${queued} unsynced page(s) from this device? This can't be undone.`
      )) {
        return;
      }
      clear.disabled = true;
      message.textContent = "";
      try {
        const response = await sendBg({ type: "clearQueue" });
        if (!response?.ok) throw new Error(response?.error ?? "failed");
        message.textContent = "Queue cleared.";
      } catch {
        message.textContent = "Couldn't clear the queue.";
      } finally {
        clear.disabled = false;
      }
    });
    return h("details", { class: "section diagnostics" }, [
      h("summary", {}, ["Diagnostics"]),
      h("p", { class: "hint" }, [
        "Account settings and security controls live on webtm.io."
      ]),
      h("div", { class: "row" }, [clear, message])
    ]);
  }
  void renderApp();
})();
