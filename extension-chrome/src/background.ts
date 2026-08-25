// Background worker: the ONLY context that mutates extension storage. The
// popup sends messages for every mutation (setState / clearQueue), which is
// what makes storage.ts's per-context mutex a real mutex. Owns the capture
// queue and syncs it to the backend.
import { WtmApiError, WtmClient } from "@wtm/shared/api";
import type { CapturedPage } from "@wtm/shared";
import { deviceOwnerKey, PLATFORM, type ExtState } from "./config";
import {
  applyStatePatch,
  clearQueue,
  enqueue,
  getQueue,
  getState,
  isQuotaError,
  raiseCeilingAfterCleanDrain,
  removeSyncedIds,
} from "./storage";

const FLUSH_ALARM = "wtm:flush";
const BATCH = 50;
// Cap the JSON payload of one push. 50 text-heavy mobile captures can exceed
// several MB, which flaky mobile networks reject; smaller pushes land.
const BATCH_SOFT_BYTES = 1_000_000;
const SEARCH_URL = "https://webtm.io/search";
const ROUTER_RULE_IDS = [9101, 9102, 9103];

function takeBatch(queue: CapturedPage[]): CapturedPage[] {
  const batch: CapturedPage[] = [];
  let bytes = 0;
  for (const p of queue.slice(0, BATCH)) {
    bytes += (p.text?.length ?? 0) + 512;
    if (batch.length && bytes > BATCH_SOFT_BYTES) break;
    batch.push(p);
  }
  return batch;
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
  void configureSearchRouter();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
  void configureSearchRouter();
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
        const page: CapturedPage = { id: crypto.randomUUID(), ...msg.page };
        const changed = await enqueue([page]);
        if (changed) scheduleFlush();
        return sendResponse({ ok: true, added: changed });
      }
      if (msg?.type === "flushNow") {
        await flush();
        return sendResponse({ ok: true });
      }
      if (msg?.type === "setState" && msg.patch && typeof msg.patch === "object") {
        const changesRouter = Object.hasOwn(msg.patch, "searchRouterEnabled");
        const previousRouter = changesRouter
          ? (await getState()).searchRouterEnabled
          : null;
        const state = await applyStatePatch(msg.patch as Partial<ExtState>);
        if (
          Object.hasOwn(msg.patch, "assistToken") ||
          Object.hasOwn(msg.patch, "assistEnabled")
        ) {
          resetSuggestionCache();
        }
        if (changesRouter) {
          try {
            await configureSearchRouter(state);
          } catch (error) {
            await applyStatePatch({ searchRouterEnabled: previousRouter ?? false });
            throw error;
          }
        }
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
  return true; // keep the message channel open for the async response
});

// ---------------------------------------------------------------------------
// Desktop Chrome omnibox. Safari does not expose this API, so the same shared
// background bundle simply skips registration there.
// ---------------------------------------------------------------------------

const omnibox = (chrome as typeof chrome & { omnibox?: typeof chrome.omnibox }).omnibox;
let suggestionGeneration = 0;
let suggestionTimer: ReturnType<typeof setTimeout> | null = null;
let suggestionAbort: AbortController | null = null;
const suggestionCache = new Map<string, chrome.omnibox.SuggestResult[]>();

function resetSuggestionCache(): void {
  suggestionGeneration++;
  if (suggestionTimer) clearTimeout(suggestionTimer);
  suggestionTimer = null;
  suggestionAbort?.abort();
  suggestionAbort = null;
  suggestionCache.clear();
}

if (PLATFORM === "chrome" && omnibox) {
  omnibox.setDefaultSuggestion({
    description: "Search your Web Time Machine history",
  });
  omnibox.onInputChanged.addListener((text, suggest) => {
    const generation = ++suggestionGeneration;
    if (suggestionTimer) clearTimeout(suggestionTimer);
    suggestionAbort?.abort();
    const query = text.trim();
    if (query.length < 2) {
      suggest([]);
      return;
    }
    const cached = suggestionCache.get(query.toLowerCase());
    if (cached) {
      suggest(cached);
      return;
    }
    suggestionTimer = setTimeout(() => {
      suggestionTimer = null;
      const controller = new AbortController();
      suggestionAbort = controller;
      void getOmniboxSuggestions(query, controller.signal).then((results) => {
        if (generation !== suggestionGeneration) return;
        suggestionCache.set(query.toLowerCase(), results);
        if (suggestionCache.size > 40) {
          suggestionCache.delete(suggestionCache.keys().next().value ?? "");
        }
        suggest(results);
      });
    }, 90);
  });
  omnibox.onInputEntered.addListener((text, disposition) => {
    void openOmniboxResult(text, disposition);
  });
}

function escapeOmnibox(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function getOmniboxSuggestions(
  query: string,
  signal: AbortSignal,
): Promise<chrome.omnibox.SuggestResult[]> {
  const state = await getState();
  if (!state.assistEnabled || !state.assistToken) {
    omnibox?.setDefaultSuggestion({
      description: "Enable Search Assist from the Web Time Machine extension",
    });
    return [];
  }
  try {
    const response = await new WtmClient({
      baseUrl: state.baseUrl,
      token: state.assistToken,
    }).suggest(query, 6, signal);
    omnibox?.setDefaultSuggestion({
      description: `Search Web Time Machine for <match>${escapeOmnibox(query)}</match>`,
    });
    return response.suggestions.map((item) => ({
      content: item.url,
      description:
        `<match>${escapeOmnibox(item.title || item.url)}</match> ` +
        `<dim>${escapeOmnibox(new URL(item.url).hostname)}</dim>`,
      deletable: false,
    }));
  } catch (error) {
    if (error instanceof WtmApiError && error.status === 401) {
      await applyStatePatch({
        assistToken: null,
        assistEnabled: false,
        lastAssistError: "Search Assist authorization expired. Enable it again to reconnect.",
      });
      resetSuggestionCache();
    }
    return [];
  }
}

async function openOmniboxResult(
  text: string,
  disposition: chrome.omnibox.OnInputEnteredDisposition,
): Promise<void> {
  let url = text.trim();
  if (!/^https?:\/\//i.test(url)) {
    const search = new URL(SEARCH_URL);
    search.searchParams.set("q", url);
    url = search.toString();
  }
  if (disposition === "newForegroundTab") {
    await chrome.tabs.create({ url, active: true });
  } else if (disposition === "newBackgroundTab") {
    await chrome.tabs.create({ url, active: false });
  } else {
    await chrome.tabs.update({ url });
  }
}

// ---------------------------------------------------------------------------
// iOS submitted-query router. It cannot replace Safari autocomplete or add a
// native engine; it only redirects explicit `wtm ` / `!w ` submissions.
// ---------------------------------------------------------------------------

async function configureSearchRouter(existing?: ExtState): Promise<void> {
  if (PLATFORM !== "safari-ios" || !chrome.declarativeNetRequest) return;
  const state = existing ?? (await getState());
  const rules: chrome.declarativeNetRequest.Rule[] = state.searchRouterEnabled
    ? [
        routerRule(9101, "^https?://(?:www\\.)?google\\.[^/]+/search\\?(?:[^#]*&)?q=(?:wtm(?:%20|\\+)|(?:%21|!)w(?:%20|\\+))([^&#]+)(?:&.*)?$"),
        routerRule(9102, "^https?://(?:www\\.)?bing\\.com/search\\?(?:[^#]*&)?q=(?:wtm(?:%20|\\+)|(?:%21|!)w(?:%20|\\+))([^&#]+)(?:&.*)?$"),
        routerRule(9103, "^https?://(?:www\\.)?duckduckgo\\.com/\\?(?:[^#]*&)?q=(?:wtm(?:%20|\\+)|(?:%21|!)w(?:%20|\\+))([^&#]+)(?:&.*)?$"),
      ]
    : [];
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: ROUTER_RULE_IDS,
    addRules: rules,
  });
}

function routerRule(id: number, regexFilter: string): chrome.declarativeNetRequest.Rule {
  return {
    id,
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
      redirect: { regexSubstitution: `${SEARCH_URL}?q=\\1` },
    },
    condition: {
      regexFilter,
      resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME],
    },
  };
}

function scheduleFlush(delay = 2500): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, delay);
}

async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const st = await getState();
    if (!st.token || !st.baseUrl || !st.user) return;
    if (!(await getQueue()).length) return;

    const client = new WtmClient({ baseUrl: st.baseUrl, token: st.token });

    // The node id is generated CLIENT-side, per (install, account) — the
    // backend upserts a supplied id it already owns, so re-registering the
    // same id is idempotent and duplicate nodes can't accumulate even if the
    // state write below never lands. A different account (or backend) gets a
    // fresh id, since a supplied id owned by another user would 409.
    const owner = deviceOwnerKey(st.baseUrl, st.user.id);
    let deviceId = st.deviceOwner === owner && st.deviceId ? st.deviceId : null;
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      await client.registerNode({ id: deviceId, name: deviceName(), platform: PLATFORM });
      await applyStatePatch({ deviceId, deviceOwner: owner });
    }

    // Drain in batches. syncedIds spans the whole run: pages the server has
    // acked are filtered out of every later read, so a removal that fails to
    // stick (storage pressure, context kill) can never head-of-line block the
    // rest of the backlog — the next run re-pushes at most one already-acked
    // batch (idempotent server upsert) and retries the removal.
    const syncedIds = new Set<string>();
    let removalError: unknown = null;
    while (true) {
      const current = (await getQueue()).filter((p) => !syncedIds.has(p.id));
      if (!current.length) break;
      const batch = takeBatch(current);
      await client.push({ deviceId, pages: batch });
      for (const p of batch) syncedIds.add(p.id);
      // lastSync advances per landed batch — "synced" means data reached the
      // server, not that the queue happened to be empty.
      await applyStatePatch({ lastSync: Date.now(), lastError: null, lastErrorAt: null });
      // A removal that can't stick (storage wedged) must not abort the drain:
      // the syncedIds filter makes continuing safe, so push the WHOLE backlog
      // first and surface the storage problem afterwards.
      try {
        await removeSyncedIds(syncedIds);
        removalError = null;
      } catch (e) {
        if (!isQuotaError(e)) throw e;
        removalError = e;
      }
    }
    if (removalError) throw removalError;

    // A drain that completed without throwing lets a learned quota ceiling
    // heal upward (10% per clean run, gone once it reaches the default).
    await raiseCeilingAfterCleanDrain();
  } catch (e) {
    const paused = isQuotaError(e) && /even empty/i.test((e as Error).message ?? "");
    const msg =
      e instanceof WtmApiError
        ? `${e.status} ${e.message}`
        : paused
          ? "Device storage is full for this extension — capture is paused. Free up storage or use Settings → Clear stuck queue."
          : isQuotaError(e)
            ? `Device storage was full — oldest unsynced captures were trimmed. Sync continues. [${(e as Error).message?.slice(0, 100) ?? e}]`
            : String(e);
    try {
      await applyStatePatch({ lastError: msg, lastErrorAt: Date.now() });
      if (e instanceof WtmApiError && e.status === 401) {
        // Token expired/invalid — drop it so the popup prompts a re-login;
        // keep deviceId/deviceOwner so the same account reuses this node.
        await applyStatePatch({ token: null, tokenScope: null });
      }
    } catch {
      // Reporting the error must never itself throw (e.g. storage still full).
    }
  } finally {
    flushing = false;
  }
}

function deviceName(): string {
  const ua = navigator.userAgent;
  if (PLATFORM === "safari-ios") {
    return /iPad/.test(ua) ? "Safari on iPad" : "Safari on iPhone";
  }
  if (PLATFORM === "firefox-android") return "Firefox on Android";
  const os = /Macintosh|Mac OS/.test(ua)
    ? "macOS"
    : /Windows/.test(ua)
      ? "Windows"
      : /CrOS/.test(ua)
        ? "ChromeOS"
        : /Linux|X11/.test(ua)
          ? "Linux"
          : "Chrome";
  return `Chrome on ${os}`;
}
