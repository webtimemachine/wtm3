// Background service worker: owns the capture queue and syncs it to the backend.
import { WtmApiError, WtmClient } from "@wtm/shared/api";
import type { CapturedPage } from "@wtm/shared";
import { PLATFORM } from "./config";
import { enqueue, getQueue, getState, setQueue, setState } from "./storage";

const FLUSH_ALARM = "wtm:flush";
const BATCH = 50;

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

chrome.runtime.onInstalled.addListener(async () => {
  await getState(); // materialize defaults
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
        const page: CapturedPage = { id: crypto.randomUUID(), ...msg.page };
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
  return true; // keep the message channel open for the async response
});

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
    if (!st.token || !st.baseUrl) return;
    if (!(await getQueue()).length) return;

    const client = new WtmClient({ baseUrl: st.baseUrl, token: st.token });

    let deviceId = st.deviceId;
    if (!deviceId) {
      const node = await client.registerNode({ name: deviceName(), platform: PLATFORM });
      deviceId = node.id;
      await setState({ deviceId });
    }

    // Drain in batches. Re-read storage after each push and remove only the
    // acked ids, so pages enqueued during an in-flight upload aren't clobbered.
    while (true) {
      const current = await getQueue();
      if (!current.length) break;
      const batch = current.slice(0, BATCH);
      const acked = new Set(batch.map((p) => p.id));
      await client.push({ deviceId, pages: batch });
      const after = await getQueue();
      await setQueue(after.filter((p) => !acked.has(p.id)));
    }
    await setState({ lastSync: Date.now(), lastError: null });
  } catch (e) {
    const msg = e instanceof WtmApiError ? `${e.status} ${e.message}` : String(e);
    await setState({ lastError: msg });
    if (e instanceof WtmApiError && e.status === 401) {
      // Token expired/invalid — drop it so the popup prompts a re-login.
      await setState({ token: null, deviceId: null });
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
