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
    account: "/account",
    me: "/auth/me",
    settings: "/settings",
    nodes: "/nodes",
    node: (id) => `/nodes/${id}`,
    syncPush: "/sync/push",
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

  // ../extension-chrome/src/config.ts
  var injectedPlatform = true ? "safari-ios" : "chrome";
  var PLATFORM = injectedPlatform === "firefox-android" || injectedPlatform === "safari-ios" ? injectedPlatform : "chrome";
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
  var flm = /* @__PURE__ */ hMap(flt, 9, 0);
  var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
  var fdm = /* @__PURE__ */ hMap(fdt, 5, 0);
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
  var wbits = function(d, p, v) {
    v <<= p & 7;
    var o = p / 8 | 0;
    d[o] |= v;
    d[o + 1] |= v >> 8;
  };
  var wbits16 = function(d, p, v) {
    v <<= p & 7;
    var o = p / 8 | 0;
    d[o] |= v;
    d[o + 1] |= v >> 8;
    d[o + 2] |= v >> 16;
  };
  var hTree = function(d, mb) {
    var t = [];
    for (var i = 0; i < d.length; ++i) {
      if (d[i])
        t.push({ s: i, f: d[i] });
    }
    var s = t.length;
    var t2 = t.slice();
    if (!s)
      return { t: et, l: 0 };
    if (s == 1) {
      var v = new u8(t[0].s + 1);
      v[t[0].s] = 1;
      return { t: v, l: 1 };
    }
    t.sort(function(a, b) {
      return a.f - b.f;
    });
    t.push({ s: -1, f: 25001 });
    var l = t[0], r = t[1], i0 = 0, i1 = 1, i2 = 2;
    t[0] = { s: -1, f: l.f + r.f, l, r };
    while (i1 != s - 1) {
      l = t[t[i0].f < t[i2].f ? i0++ : i2++];
      r = t[i0 != i1 && t[i0].f < t[i2].f ? i0++ : i2++];
      t[i1++] = { s: -1, f: l.f + r.f, l, r };
    }
    var maxSym = t2[0].s;
    for (var i = 1; i < s; ++i) {
      if (t2[i].s > maxSym)
        maxSym = t2[i].s;
    }
    var tr = new u16(maxSym + 1);
    var mbt = ln(t[i1 - 1], tr, 0);
    if (mbt > mb) {
      var i = 0, dt = 0;
      var lft = mbt - mb, cst = 1 << lft;
      t2.sort(function(a, b) {
        return tr[b.s] - tr[a.s] || a.f - b.f;
      });
      for (; i < s; ++i) {
        var i2_1 = t2[i].s;
        if (tr[i2_1] > mb) {
          dt += cst - (1 << mbt - tr[i2_1]);
          tr[i2_1] = mb;
        } else
          break;
      }
      dt >>= lft;
      while (dt > 0) {
        var i2_2 = t2[i].s;
        if (tr[i2_2] < mb)
          dt -= 1 << mb - tr[i2_2]++ - 1;
        else
          ++i;
      }
      for (; i >= 0 && dt; --i) {
        var i2_3 = t2[i].s;
        if (tr[i2_3] == mb) {
          --tr[i2_3];
          ++dt;
        }
      }
      mbt = mb;
    }
    return { t: new u8(tr), l: mbt };
  };
  var ln = function(n, l, d) {
    return n.s == -1 ? Math.max(ln(n.l, l, d + 1), ln(n.r, l, d + 1)) : l[n.s] = d;
  };
  var lc = function(c) {
    var s = c.length;
    while (s && !c[--s])
      ;
    var cl = new u16(++s);
    var cli = 0, cln = c[0], cls = 1;
    var w = function(v) {
      cl[cli++] = v;
    };
    for (var i = 1; i <= s; ++i) {
      if (c[i] == cln && i != s)
        ++cls;
      else {
        if (!cln && cls > 2) {
          for (; cls > 138; cls -= 138)
            w(32754);
          if (cls > 2) {
            w(cls > 10 ? cls - 11 << 5 | 28690 : cls - 3 << 5 | 12305);
            cls = 0;
          }
        } else if (cls > 3) {
          w(cln), --cls;
          for (; cls > 6; cls -= 6)
            w(8304);
          if (cls > 2)
            w(cls - 3 << 5 | 8208), cls = 0;
        }
        while (cls--)
          w(cln);
        cls = 1;
        cln = c[i];
      }
    }
    return { c: cl.subarray(0, cli), n: s };
  };
  var clen = function(cf, cl) {
    var l = 0;
    for (var i = 0; i < cl.length; ++i)
      l += cf[i] * cl[i];
    return l;
  };
  var wfblk = function(out, pos, dat) {
    var s = dat.length;
    var o = shft(pos + 2);
    out[o] = s & 255;
    out[o + 1] = s >> 8;
    out[o + 2] = out[o] ^ 255;
    out[o + 3] = out[o + 1] ^ 255;
    for (var i = 0; i < s; ++i)
      out[o + i + 4] = dat[i];
    return (o + 4 + s) * 8;
  };
  var wblk = function(dat, out, final, syms, lf, df, eb, li, bs, bl, p) {
    wbits(out, p++, final);
    ++lf[256];
    var _a2 = hTree(lf, 15), dlt = _a2.t, mlb = _a2.l;
    var _b2 = hTree(df, 15), ddt = _b2.t, mdb = _b2.l;
    var _c = lc(dlt), lclt = _c.c, nlc = _c.n;
    var _d = lc(ddt), lcdt = _d.c, ndc = _d.n;
    var lcfreq = new u16(19);
    for (var i = 0; i < lclt.length; ++i)
      ++lcfreq[lclt[i] & 31];
    for (var i = 0; i < lcdt.length; ++i)
      ++lcfreq[lcdt[i] & 31];
    var _e = hTree(lcfreq, 7), lct = _e.t, mlcb = _e.l;
    var nlcc = 19;
    for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc)
      ;
    var flen = bl + 5 << 3;
    var ftlen = clen(lf, flt) + clen(df, fdt) + eb;
    var dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + 2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18];
    if (bs >= 0 && flen <= ftlen && flen <= dtlen)
      return wfblk(out, p, dat.subarray(bs, bs + bl));
    var lm, ll, dm, dl;
    wbits(out, p, 1 + (dtlen < ftlen)), p += 2;
    if (dtlen < ftlen) {
      lm = hMap(dlt, mlb, 0), ll = dlt, dm = hMap(ddt, mdb, 0), dl = ddt;
      var llm = hMap(lct, mlcb, 0);
      wbits(out, p, nlc - 257);
      wbits(out, p + 5, ndc - 1);
      wbits(out, p + 10, nlcc - 4);
      p += 14;
      for (var i = 0; i < nlcc; ++i)
        wbits(out, p + 3 * i, lct[clim[i]]);
      p += 3 * nlcc;
      var lcts = [lclt, lcdt];
      for (var it = 0; it < 2; ++it) {
        var clct = lcts[it];
        for (var i = 0; i < clct.length; ++i) {
          var len = clct[i] & 31;
          wbits(out, p, llm[len]), p += lct[len];
          if (len > 15)
            wbits(out, p, clct[i] >> 5 & 127), p += clct[i] >> 12;
        }
      }
    } else {
      lm = flm, ll = flt, dm = fdm, dl = fdt;
    }
    for (var i = 0; i < li; ++i) {
      var sym = syms[i];
      if (sym > 255) {
        var len = sym >> 18 & 31;
        wbits16(out, p, lm[len + 257]), p += ll[len + 257];
        if (len > 7)
          wbits(out, p, sym >> 23 & 31), p += fleb[len];
        var dst = sym & 31;
        wbits16(out, p, dm[dst]), p += dl[dst];
        if (dst > 3)
          wbits16(out, p, sym >> 5 & 8191), p += fdeb[dst];
      } else {
        wbits16(out, p, lm[sym]), p += ll[sym];
      }
    }
    wbits16(out, p, lm[256]);
    return p + ll[256];
  };
  var deo = /* @__PURE__ */ new i32([65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632]);
  var et = /* @__PURE__ */ new u8(0);
  var dflt = function(dat, lvl, plvl, pre, post, st) {
    var s = st.z || dat.length;
    var o = new u8(pre + s + 5 * (1 + Math.ceil(s / 7e3)) + post);
    var w = o.subarray(pre, o.length - post);
    var lst = st.l;
    var pos = (st.r || 0) & 7;
    if (lvl) {
      if (pos)
        w[0] = st.r >> 3;
      var opt = deo[lvl - 1];
      var n = opt >> 13, c = opt & 8191;
      var msk_1 = (1 << plvl) - 1;
      var prev = st.p || new u16(32768), head = st.h || new u16(msk_1 + 1);
      var bs1_1 = Math.ceil(plvl / 3), bs2_1 = 2 * bs1_1;
      var hsh = function(i2) {
        return (dat[i2] ^ dat[i2 + 1] << bs1_1 ^ dat[i2 + 2] << bs2_1) & msk_1;
      };
      var syms = new i32(25e3);
      var lf = new u16(288), df = new u16(32);
      var lc_1 = 0, eb = 0, i = st.i || 0, li = 0, wi = st.w || 0, bs = 0;
      for (; i + 2 < s; ++i) {
        var hv = hsh(i);
        var imod = i & 32767, pimod = head[hv];
        prev[imod] = pimod;
        head[hv] = imod;
        if (wi <= i) {
          var rem = s - i;
          if ((lc_1 > 7e3 || li > 24576) && (rem > 423 || !lst)) {
            pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i - bs, pos);
            li = lc_1 = eb = 0, bs = i;
            for (var j = 0; j < 286; ++j)
              lf[j] = 0;
            for (var j = 0; j < 30; ++j)
              df[j] = 0;
          }
          var l = 2, d = 0, ch_1 = c, dif = imod - pimod & 32767;
          if (rem > 2 && hv == hsh(i - dif)) {
            var maxn = Math.min(n, rem) - 1;
            var maxd = Math.min(32767, i);
            var ml = Math.min(258, rem);
            while (dif <= maxd && --ch_1 && imod != pimod) {
              if (dat[i + l] == dat[i + l - dif]) {
                var nl = 0;
                for (; nl < ml && dat[i + nl] == dat[i + nl - dif]; ++nl)
                  ;
                if (nl > l) {
                  l = nl, d = dif;
                  if (nl > maxn)
                    break;
                  var mmd = Math.min(dif, nl - 2);
                  var md = 0;
                  for (var j = 0; j < mmd; ++j) {
                    var ti = i - dif + j & 32767;
                    var pti = prev[ti];
                    var cd = ti - pti & 32767;
                    if (cd > md)
                      md = cd, pimod = ti;
                  }
                }
              }
              imod = pimod, pimod = prev[imod];
              dif += imod - pimod & 32767;
            }
          }
          if (d) {
            syms[li++] = 268435456 | revfl[l] << 18 | revfd[d];
            var lin = revfl[l] & 31, din = revfd[d] & 31;
            eb += fleb[lin] + fdeb[din];
            ++lf[257 + lin];
            ++df[din];
            wi = i + l;
            ++lc_1;
          } else {
            syms[li++] = dat[i];
            ++lf[dat[i]];
          }
        }
      }
      for (i = Math.max(i, wi); i < s; ++i) {
        syms[li++] = dat[i];
        ++lf[dat[i]];
      }
      pos = wblk(dat, w, lst, syms, lf, df, eb, li, bs, i - bs, pos);
      if (!lst) {
        st.r = pos & 7 | w[pos / 8 | 0] << 3;
        pos -= 7;
        st.h = head, st.p = prev, st.i = i, st.w = wi;
      }
    } else {
      for (var i = st.w || 0; i < s + lst; i += 65535) {
        var e = i + 65535;
        if (e >= s) {
          w[pos / 8 | 0] = lst;
          e = s;
        }
        pos = wfblk(w, pos + 1, dat.subarray(i, e));
      }
      st.i = s;
    }
    return slc(o, 0, pre + shft(pos) + post);
  };
  var crct = /* @__PURE__ */ function() {
    var t = new Int32Array(256);
    for (var i = 0; i < 256; ++i) {
      var c = i, k = 9;
      while (--k)
        c = (c & 1 && -306674912) ^ c >>> 1;
      t[i] = c;
    }
    return t;
  }();
  var crc = function() {
    var c = -1;
    return {
      p: function(d) {
        var cr = c;
        for (var i = 0; i < d.length; ++i)
          cr = crct[cr & 255 ^ d[i]] ^ cr >>> 8;
        c = cr;
      },
      d: function() {
        return ~c;
      }
    };
  };
  var dopt = function(dat, opt, pre, post, st) {
    if (!st) {
      st = { l: 1 };
      if (opt.dictionary) {
        var dict = opt.dictionary.subarray(-32768);
        var newDat = new u8(dict.length + dat.length);
        newDat.set(dict);
        newDat.set(dat, dict.length);
        dat = newDat;
        st.w = dict.length;
      }
    }
    return dflt(dat, opt.level == null ? 6 : opt.level, opt.mem == null ? st.l ? Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5) : 20 : 12 + opt.mem, pre, post, st);
  };
  var wbytes = function(d, b, v) {
    for (; v; ++b)
      d[b] = v, v >>>= 8;
  };
  var gzh = function(c, o) {
    var fn = o.filename;
    c[0] = 31, c[1] = 139, c[2] = 8, c[8] = o.level < 2 ? 4 : o.level == 9 ? 2 : 0, c[9] = 3;
    if (o.mtime != 0)
      wbytes(c, 4, Math.floor(new Date(o.mtime || Date.now()) / 1e3));
    if (fn) {
      c[3] = 8;
      for (var i = 0; i <= fn.length; ++i)
        c[i + 10] = fn.charCodeAt(i);
    }
  };
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
  var gzhl = function(o) {
    return 10 + (o.filename ? o.filename.length + 1 : 0);
  };
  function gzipSync(data, opts) {
    if (!opts)
      opts = {};
    var c = crc(), l = data.length;
    c.p(data);
    var d = dopt(data, opts, gzhl(opts), 8), s = d.length;
    return gzh(d, opts), wbytes(d, s - 8, c.d()), wbytes(d, s - 4, l), d;
  }
  function gunzipSync(data, opts) {
    var st = gzs(data);
    if (st + 8 > data.length)
      err(6, "invalid gzip data");
    return inflt(data.subarray(st, -8), { i: 2 }, opts && opts.out || new u8(gzl(data)), opts && opts.dictionary);
  }
  var te = typeof TextEncoder != "undefined" && /* @__PURE__ */ new TextEncoder();
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
  function strToU8(str, latin1) {
    if (latin1) {
      var ar_1 = new u8(str.length);
      for (var i = 0; i < str.length; ++i)
        ar_1[i] = str.charCodeAt(i);
      return ar_1;
    }
    if (te)
      return te.encode(str);
    var l = str.length;
    var ar = new u8(str.length + (str.length >> 1));
    var ai = 0;
    var w = function(v) {
      ar[ai++] = v;
    };
    for (var i = 0; i < l; ++i) {
      if (ai + 5 > ar.length) {
        var n = new u8(ai + 8 + (l - i << 1));
        n.set(ar);
        ar = n;
      }
      var c = str.charCodeAt(i);
      if (c < 128 || latin1)
        w(c);
      else if (c < 2048)
        w(192 | c >> 6), w(128 | c & 63);
      else if (c > 55295 && c < 57344)
        c = 65536 + (c & 1023 << 10) | str.charCodeAt(++i) & 1023, w(240 | c >> 18), w(128 | c >> 12 & 63), w(128 | c >> 6 & 63), w(128 | c & 63);
      else
        w(224 | c >> 12), w(128 | c >> 6 & 63), w(128 | c & 63);
    }
    return slc(ar, 0, ai);
  }
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
  function gzipToB64(text) {
    const bytes = gzipSync(strToU8(text));
    let s = "";
    for (let i = 0; i < bytes.length; i += 32768) {
      s += String.fromCharCode(...bytes.subarray(i, i + 32768));
    }
    return btoa(s);
  }
  function gunzipFromB64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return strFromU8(gunzipSync(bytes));
  }

  // ../extension-chrome/src/storage.ts
  var STATE_KEY = "wtm:state";
  var QUEUE_KEY = "wtm:queue";
  var CEILING_KEY = "wtm:quotaCeiling";
  var CORRUPT_KEY = "wtm:queue:corrupt";
  var QUEUE_SOFT_PLATFORM_BYTES = PLATFORM === "safari-ios" ? 4e5 : 4e6;
  var CEILING_FLOOR_BYTES = 65536;
  var CEILING_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
  var IOS_PAGE_TEXT_CAP = 6e4;
  function storedSize(value) {
    const json = JSON.stringify(value);
    return PLATFORM === "safari-ios" ? json.length * 2 : new TextEncoder().encode(json).length;
  }
  function isQuotaError(e) {
    const s = `${e?.message ?? e}`.toLowerCase();
    return s.includes("quota") || s.includes("exceeded");
  }
  function tagError(op, e) {
    return new Error(`${op}: ${e?.message ?? e}`);
  }
  function dropOldest(q, fraction) {
    return q.length <= 1 ? [] : q.slice(Math.max(1, Math.ceil(q.length * fraction)));
  }
  var storageLock = Promise.resolve();
  function withStorageLock(fn) {
    const run = storageLock.then(fn, fn);
    storageLock = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  async function safeSet(key, value) {
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch (e) {
      if (!isQuotaError(e)) throw e;
      await chrome.storage.local.remove(key);
      await chrome.storage.local.set({ [key]: value });
    }
  }
  var ceiling = null;
  var ceilingLoaded = false;
  var ceilingDirty = false;
  async function loadCeiling() {
    if (ceilingLoaded) return;
    try {
      const o = await chrome.storage.local.get(CEILING_KEY);
      const c = o[CEILING_KEY];
      if (c && typeof c.bytes === "number" && typeof c.learnedAt === "number" && Date.now() - c.learnedAt < CEILING_TTL_MS && ceiling === null) {
        ceiling = c;
      }
    } catch {
    }
    ceilingLoaded = true;
  }
  function noteQuotaHit(platformBytes) {
    const learned = Math.max(CEILING_FLOOR_BYTES, Math.floor(platformBytes * 0.75));
    if (!ceiling || learned < ceiling.bytes) {
      ceiling = { bytes: learned, learnedAt: Date.now() };
      ceilingDirty = true;
    }
  }
  async function persistCeilingIfDirty() {
    if (!ceilingDirty || !ceiling) return;
    try {
      await chrome.storage.local.set({ [CEILING_KEY]: ceiling });
      ceilingDirty = false;
    } catch {
    }
  }
  async function raiseCeilingAfterCleanDrain() {
    await loadCeiling();
    if (!ceiling) return;
    const raised = Math.floor(ceiling.bytes * 1.1);
    if (raised >= QUEUE_SOFT_PLATFORM_BYTES) {
      ceiling = null;
      ceilingDirty = false;
      try {
        await chrome.storage.local.remove(CEILING_KEY);
      } catch {
      }
    } else {
      ceiling = { bytes: raised, learnedAt: ceiling.learnedAt };
      ceilingDirty = true;
      await persistCeilingIfDirty();
    }
  }
  async function getState() {
    const o = await chrome.storage.local.get(STATE_KEY);
    return { ...DEFAULT_STATE, ...o[STATE_KEY] ?? {} };
  }
  function applyStatePatch(patch) {
    return withStorageLock(async () => {
      await loadCeiling();
      const next = { ...await getState(), ...patch };
      for (; ; ) {
        try {
          await safeSet(STATE_KEY, next);
          await persistCeilingIfDirty();
          return next;
        } catch (e) {
          if (!isQuotaError(e)) throw e;
          const read = await readQueueInternal();
          if (read.format === "corrupt") {
            await quarantineCorrupt(read.raw);
            continue;
          }
          if (read.pages.length === 0) throw tagError("state write (queue already empty)", e);
          await writeQueueInternal(dropOldest(read.pages, 0.25));
        }
      }
    });
  }
  function encodeQueue(pages) {
    return { v: 2, n: pages.length, gz: gzipToB64(JSON.stringify(pages)) };
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
  async function quarantineCorrupt(raw) {
    try {
      const existing = await chrome.storage.local.get(CORRUPT_KEY);
      await chrome.storage.local.remove(QUEUE_KEY);
      if (existing[CORRUPT_KEY] != null) return;
      const budget = Math.min(QUEUE_SOFT_PLATFORM_BYTES, ceiling?.bytes ?? Number.POSITIVE_INFINITY);
      const value = storedSize(raw) <= budget * 0.25 ? { at: Date.now(), raw } : { at: Date.now(), bytes: storedSize(raw), stub: true };
      await chrome.storage.local.set({ [CORRUPT_KEY]: value });
    } catch {
      try {
        await chrome.storage.local.remove(QUEUE_KEY);
      } catch {
      }
    }
  }
  async function writeQueueInternal(pages) {
    await loadCeiling();
    const budget = Math.min(QUEUE_SOFT_PLATFORM_BYTES, ceiling?.bytes ?? Number.POSITIVE_INFINITY);
    let current = pages;
    let payload = encodeQueue(current);
    while (current.length > 1 && storedSize(payload) > budget) {
      current = dropOldest(current, 0.1);
      payload = encodeQueue(current);
    }
    for (; ; ) {
      try {
        await safeSet(QUEUE_KEY, payload);
        await persistCeilingIfDirty();
        return;
      } catch (e) {
        if (!isQuotaError(e)) throw e;
        noteQuotaHit(storedSize(payload));
        if (current.length === 0) throw tagError("queue write (even empty queue rejected)", e);
        current = dropOldest(current, 0.25);
        payload = encodeQueue(current);
      }
    }
  }
  async function getQueue() {
    return (await readQueueInternal()).pages;
  }
  function enqueue(pages) {
    return withStorageLock(async () => {
      const read = await readQueueInternal();
      if (read.format === "corrupt") await quarantineCorrupt(read.raw);
      const q = read.format === "corrupt" ? [] : read.pages;
      const capped = PLATFORM === "safari-ios" ? pages.map((p) => p.text.length > IOS_PAGE_TEXT_CAP ? { ...p, text: p.text.slice(0, IOS_PAGE_TEXT_CAP) } : p) : pages;
      const indexByUrl = new Map(q.map((p, i) => [p.url, i]));
      const next = [...q];
      let changed = 0;
      for (const p of capped) {
        const i = indexByUrl.get(p.url);
        if (i === void 0) {
          indexByUrl.set(p.url, next.length);
          next.push(p);
        } else {
          next[i] = p;
        }
        changed++;
      }
      if (changed) await writeQueueInternal(next);
      return changed;
    });
  }
  function removeSyncedIds(ids) {
    return withStorageLock(async () => {
      const read = await readQueueInternal();
      if (read.format === "corrupt") {
        await quarantineCorrupt(read.raw);
        return;
      }
      const filtered = read.pages.filter((p) => !ids.has(p.id));
      const needsMigration = read.format === "plain" || read.format === "v1";
      if (filtered.length !== read.pages.length || needsMigration) {
        await writeQueueInternal(filtered);
      }
    });
  }
  function clearQueue() {
    return withStorageLock(async () => {
      await chrome.storage.local.remove(QUEUE_KEY);
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
  chrome.runtime.onInstalled.addListener(() => {
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
          const changed = await enqueue([page]);
          if (changed) scheduleFlush();
          return sendResponse({ ok: true, added: changed });
        }
        if (msg?.type === "flushNow") {
          await flush();
          return sendResponse({ ok: true });
        }
        if (msg?.type === "setState" && msg.patch && typeof msg.patch === "object") {
          const state = await applyStatePatch(msg.patch);
          if (msg.thenFlush) void flush();
          return sendResponse({ ok: true, state });
        }
        if (msg?.type === "clearQueue") {
          await clearQueue();
          return sendResponse({ ok: true, state: await getState() });
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
      if (!st.token || !st.baseUrl || !st.user) return;
      if (!(await getQueue()).length) return;
      const client = new WtmClient({ baseUrl: st.baseUrl, token: st.token });
      const owner = deviceOwnerKey(st.baseUrl, st.user.id);
      let deviceId = st.deviceOwner === owner && st.deviceId ? st.deviceId : null;
      if (!deviceId) {
        deviceId = crypto.randomUUID();
        await client.registerNode({ id: deviceId, name: deviceName(), platform: PLATFORM });
        await applyStatePatch({ deviceId, deviceOwner: owner });
      }
      const syncedIds = /* @__PURE__ */ new Set();
      let removalError = null;
      while (true) {
        const current = (await getQueue()).filter((p) => !syncedIds.has(p.id));
        if (!current.length) break;
        const batch = takeBatch(current);
        await client.push({ deviceId, pages: batch });
        for (const p of batch) syncedIds.add(p.id);
        await applyStatePatch({ lastSync: Date.now(), lastError: null, lastErrorAt: null });
        try {
          await removeSyncedIds(syncedIds);
          removalError = null;
        } catch (e) {
          if (!isQuotaError(e)) throw e;
          removalError = e;
        }
      }
      if (removalError) throw removalError;
      await raiseCeilingAfterCleanDrain();
    } catch (e) {
      const paused = isQuotaError(e) && /even empty/i.test(e.message ?? "");
      const msg = e instanceof WtmApiError ? `${e.status} ${e.message}` : paused ? "Device storage is full for this extension \u2014 capture is paused. Free up storage or use Settings \u2192 Clear stuck queue." : isQuotaError(e) ? `Device storage was full \u2014 oldest unsynced captures were trimmed. Sync continues. [${e.message?.slice(0, 100) ?? e}]` : String(e);
      try {
        await applyStatePatch({ lastError: msg, lastErrorAt: Date.now() });
        if (e instanceof WtmApiError && e.status === 401) {
          await applyStatePatch({ token: null });
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
