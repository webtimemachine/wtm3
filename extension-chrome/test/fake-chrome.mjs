// Test doubles for the WebExtension environment. The FakeStorageArea models
// the platform quirks this codebase has been burned by in the field:
//   - a hard byte quota (Chrome-style)
//   - UTF-16 accounting (Safari charges 2 bytes per code unit)
//   - double-count-on-rewrite: at the brim, set() of an existing key must fit
//     usage + newSize with NO credit for the old value (the observed Safari
//     behavior where even an empty-queue rewrite is rejected and only
//     remove() recovers)
//   - SimulatedKill via onOp: model iOS killing the extension context
//     mid-operation.

export class SimulatedKill extends Error {
  constructor(op, key) {
    super(`simulated context kill during ${op}(${key ?? ""})`);
    this.name = "SimulatedKill";
  }
}

export class FakeStorageArea {
  /**
   * @param {object} opts
   * @param {number|null} [opts.quotaBytes] total quota in *accounting* bytes; null = unlimited
   * @param {"utf8"|"utf16"} [opts.accounting]
   * @param {boolean} [opts.doubleCountOnRewrite] Safari brim model
   * @param {boolean} [opts.removeFails] pessimistic: remove() also throws quota
   * @param {Record<string, unknown>} [opts.seed] initial contents (values are JSON-serializable)
   * @param {(op: string, key?: string) => void} [opts.onOp] throw SimulatedKill to model death
   */
  constructor({ quotaBytes = null, accounting = "utf8", doubleCountOnRewrite = false, removeFails = false, seed, onOp } = {}) {
    this.quotaBytes = quotaBytes;
    this.accounting = accounting;
    this.doubleCountOnRewrite = doubleCountOnRewrite;
    this.removeFails = removeFails;
    this.onOp = onOp ?? (() => {});
    this.opLog = [];
    /** @type {Map<string, string>} key -> JSON string */
    this.store = new Map();
    if (seed) for (const [k, v] of Object.entries(seed)) this.store.set(k, JSON.stringify(v));
  }

  #chargeOf(str) {
    if (this.accounting === "utf16") return str.length * 2;
    return Buffer.byteLength(str, "utf8");
  }

  #entrySize(key, json) {
    return this.#chargeOf(key) + this.#chargeOf(json);
  }

  usage() {
    let n = 0;
    for (const [k, v] of this.store) n += this.#entrySize(k, v);
    return n;
  }

  snapshot() {
    const out = {};
    for (const [k, v] of this.store) out[k] = JSON.parse(v);
    return out;
  }

  #op(op, key) {
    this.opLog.push([op, key]);
    this.onOp(op, key);
  }

  async get(keys) {
    this.#op("get", Array.isArray(keys) ? keys.join(",") : keys);
    const wanted = keys == null ? [...this.store.keys()] : Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of wanted) if (this.store.has(k)) out[k] = JSON.parse(this.store.get(k));
    return out;
  }

  async set(obj) {
    for (const [key, value] of Object.entries(obj)) {
      this.#op("set", key);
      const json = JSON.stringify(value);
      const newSize = this.#entrySize(key, json);
      if (this.quotaBytes != null) {
        const existing = this.store.has(key) ? this.#entrySize(key, this.store.get(key)) : 0;
        const credit = this.doubleCountOnRewrite ? 0 : existing;
        const projected = this.usage() - credit + newSize;
        if (projected > this.quotaBytes) {
          throw new Error("Invalid call to storage.local.set(). Exceeded storage quota.");
        }
      }
      this.store.set(key, json);
    }
  }

  async remove(keys) {
    const wanted = Array.isArray(keys) ? keys : [keys];
    for (const k of wanted) {
      this.#op("remove", k);
      if (this.removeFails) throw new Error("Exceeded storage quota.");
      this.store.delete(k);
    }
  }

  async getBytesInUse(keys) {
    this.#op("getBytesInUse", Array.isArray(keys) ? keys?.join(",") : keys);
    if (keys == null) return this.usage();
    const wanted = Array.isArray(keys) ? keys : [keys];
    let n = 0;
    for (const k of wanted) if (this.store.has(k)) n += this.#entrySize(k, this.store.get(k));
    return n;
  }
}

/**
 * A chrome-shaped object backed by the fake storage plus a loopback message
 * bus: modules loaded with this object register onMessage listeners
 * (background) and other modules' sendMessage calls are delivered to them
 * (popup → background), matching the real extension topology.
 */
export function makeFakeChrome(storageArea, { manifestVersion = "0.0.0-test" } = {}) {
  const messageListeners = [];
  const alarmListeners = [];
  const omniboxChangedListeners = [];
  const omniboxEnteredListeners = [];
  const tabCalls = [];
  const dynamicRuleUpdates = [];
  return {
    storage: { local: storageArea },
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      sendMessage(msg) {
        return new Promise((resolve, reject) => {
          if (!messageListeners.length) return reject(new Error("no receiving end"));
          let settled = false;
          for (const fn of messageListeners) {
            fn(msg, {}, (resp) => {
              if (!settled) {
                settled = true;
                resolve(resp);
              }
            });
          }
        });
      },
      getManifest: () => ({ version: manifestVersion }),
    },
    alarms: {
      create() {},
      onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
      _fire(name) {
        for (const fn of alarmListeners) fn({ name });
      },
    },
    omnibox: {
      defaultSuggestion: null,
      setDefaultSuggestion(value) { this.defaultSuggestion = value; },
      onInputChanged: { addListener: (fn) => omniboxChangedListeners.push(fn) },
      onInputEntered: { addListener: (fn) => omniboxEnteredListeners.push(fn) },
      _change(text) {
        return new Promise((resolve) => {
          if (!omniboxChangedListeners.length) return resolve([]);
          omniboxChangedListeners.at(-1)(text, resolve);
        });
      },
      _enter(text, disposition = "currentTab") {
        for (const fn of omniboxEnteredListeners) fn(text, disposition);
      },
    },
    tabs: {
      async create(options) { tabCalls.push({ method: "create", ...options }); },
      async update(options) { tabCalls.push({ method: "update", ...options }); },
      _calls: tabCalls,
    },
    windows: {
      async create(options) { tabCalls.push({ method: "window", ...options }); },
    },
    declarativeNetRequest: {
      RuleActionType: { REDIRECT: "redirect" },
      ResourceType: { MAIN_FRAME: "main_frame" },
      async updateDynamicRules(update) { dynamicRuleUpdates.push(update); },
      _updates: dynamicRuleUpdates,
    },
    _messageListeners: messageListeners,
  };
}
