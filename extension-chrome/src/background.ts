// Background service worker: owns the capture queue and syncs it to the backend.
import { WtmApiError, WtmClient } from "@wtm/shared/api";
import type { CapturedPage } from "@wtm/shared";
import { deviceOwnerKey, PLATFORM } from "./config";
import { enqueue, getQueue, getState, isQuotaError, setQueue, setState, withQueueLock } from "./storage";

const FLUSH_ALARM = "wtm:flush";
const BATCH = 50;
// Cap the JSON payload of one push. 50 text-heavy mobile captures can exceed
// several MB, which flaky mobile networks reject; smaller pushes land.
const BATCH_SOFT_BYTES = 1_000_000;

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
// Survives a failed setState (full storage) so an aborted flush can't register
// a duplicate node on the next attempt. Owner-tagged so a different account
// logging in never inherits another account's node id.
let cachedNode: { id: string; owner: string } | null = null;

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
      // Storage full even after trimming the queue — the in-memory id keeps
      // this session syncing, and we persist again after the drain frees space.
    }

    // Drain in batches. Re-read storage after each push and remove only the
    // acked ids, so pages enqueued during an in-flight upload aren't clobbered.
    // lastSync advances after every landed batch — "synced" means data reached
    // the server, not that the queue happened to be empty at the same moment.
    while (true) {
      const current = await getQueue();
      if (!current.length) break;
      const batch = takeBatch(current);
      const acked = new Set(batch.map((p) => p.id));
      await client.push({ deviceId, pages: batch });
      await setState({ deviceId, deviceOwner: owner, lastSync: Date.now(), lastError: null, lastErrorAt: null });
      // Removal + verification as one locked step, so a capture arriving mid-
      // flush (enqueue() also takes this lock) can't interleave its own
      // read-modify-write and clobber this one.
      const stuck = await withQueueLock(async () => {
        const after = await getQueue();
        await setQueue(after.filter((p) => !acked.has(p.id)));
        // A batch that lands on the server but never leaves local storage
        // would otherwise get silently re-pushed every trigger forever
        // (harmless to the server — it's an idempotent upsert — but the real
        // backlog behind it never gets a turn, and the displayed queue count
        // never drops). Verify it actually stuck.
        const verify = await getQueue();
        return verify.some((p) => acked.has(p.id));
      });
      if (stuck) {
        // Stop this run rather than hammering the network with identical
        // pushes, and surface something diagnosable instead of a silent loop.
        throw new Error(
          `sync: ${batch.length} page(s) landed on the server but local storage didn't drop them — will retry`,
        );
      }
    }
  } catch (e) {
    // Quota hits are recovered by design (the queue trims itself), so report
    // them as what they are — a notice, not a scary raw platform error.
    const msg =
      e instanceof WtmApiError
        ? `${e.status} ${e.message}`
        : isQuotaError(e)
          ? `Device storage was full — oldest unsynced captures were trimmed. Sync continues. [${(e as Error).message?.slice(0, 100) ?? e}]`
          : String(e);
    try {
      await setState({ lastError: msg, lastErrorAt: Date.now() });
      if (e instanceof WtmApiError && e.status === 401) {
        // Token expired/invalid — drop it so the popup prompts a re-login, but
        // keep deviceId/deviceOwner so the same account reuses this node.
        await setState({ token: null });
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
