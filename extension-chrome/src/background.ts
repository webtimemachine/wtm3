// Background worker: the ONLY context that mutates extension storage. The
// popup sends messages for every mutation (setState / clearQueue), which is
// what makes storage.ts's per-context mutex a real mutex. Owns the capture
// queue and syncs it to the backend.
import { WtmApiError, WtmClient } from "@wtm/shared/api";
import type { CapturedPage, DiagnosticReport } from "@wtm/shared";
import { deviceOwnerKey, PLATFORM, type ExtState } from "./config";
import {
  applyStatePatch,
  clearQueue,
  enqueue,
  getBytesInUse,
  getCeiling,
  getQueue,
  getState,
  getStorageDiagnostics,
  isQuotaError,
  raiseCeilingAfterCleanDrain,
  removeSyncedIds,
} from "./storage";

const FLUSH_ALARM = "wtm:flush";
const BATCH = 50;
// Cap the JSON payload of one push. 50 text-heavy mobile captures can exceed
// several MB, which flaky mobile networks reject; smaller pushes land.
const BATCH_SOFT_BYTES = 1_000_000;
// At most one automatic capture-paused diagnostic per day.
const AUTO_REPORT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
        const changed = await enqueue([page]);
        if (changed) scheduleFlush();
        return sendResponse({ ok: true, added: changed });
      }
      if (msg?.type === "flushNow") {
        await flush();
        return sendResponse({ ok: true });
      }
      if (msg?.type === "setState" && msg.patch && typeof msg.patch === "object") {
        const state = await applyStatePatch(msg.patch as Partial<ExtState>);
        if (msg.thenFlush) void flush();
        return sendResponse({ ok: true, state });
      }
      if (msg?.type === "clearQueue") {
        // Capture the evidence before destroying it: a diagnostic report of
        // the stuck state goes out (best effort) ahead of the clear.
        await sendDiagnostics("clear").catch(() => {});
        await clearQueue();
        return sendResponse({ ok: true, state: await getState() });
      }
      if (msg?.type === "reportDiagnostics") {
        await sendDiagnostics("user");
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
      if (paused) await maybeAutoReport();
      if (e instanceof WtmApiError && e.status === 401) {
        // Token expired/invalid — drop it so the popup prompts a re-login;
        // keep deviceId/deviceOwner so the same account reuses this node.
        await applyStatePatch({ token: null });
      }
    } catch {
      // Reporting the error must never itself throw (e.g. storage still full).
    }
  } finally {
    flushing = false;
  }
}

/** One automatic diagnostic when capture enters the paused state, ≤1/day. */
async function maybeAutoReport(): Promise<void> {
  const st = await getState();
  if (st.lastAutoReportAt && Date.now() - st.lastAutoReportAt < AUTO_REPORT_MIN_INTERVAL_MS) return;
  // Persist the rate-limit stamp BEFORE sending: a duplicate report is
  // cheaper than a send-loop if the stamp write keeps failing afterward.
  await applyStatePatch({ lastAutoReportAt: Date.now() });
  await sendDiagnostics("auto").catch(() => {});
}

/** Build and POST a diagnostic snapshot. Throws only for the "user" trigger. */
async function sendDiagnostics(trigger: "user" | "auto" | "clear"): Promise<void> {
  const st = await getState();
  if (!st.token || !st.baseUrl) throw new Error("Not signed in.");
  const report = await buildDiagnosticReport(trigger);
  const client = new WtmClient({ baseUrl: st.baseUrl, token: st.token });
  await client.reportDiagnostics(report);
}

async function buildDiagnosticReport(trigger: "user" | "auto" | "clear"): Promise<DiagnosticReport> {
  const st = await getState();
  const queue = await getQueue();
  const bytes = await getBytesInUse();
  const diags = await getStorageDiagnostics();
  const ceiling = await getCeiling();
  return {
    platform: PLATFORM,
    extensionVersion: chrome.runtime.getManifest().version,
    reportedAt: Date.now(),
    deviceId: st.deviceId,
    queueLength: queue.length,
    queueRawBytes: new TextEncoder().encode(JSON.stringify(queue)).length,
    queueStoredBytes: bytes.queue ?? -1,
    quotaCeilingBytes: ceiling?.bytes ?? null,
    lastSync: st.lastSync,
    lastError: st.lastError,
    lastErrorAt: st.lastErrorAt,
    trigger,
    hasCompressionStream: diags.hasCompressionStream,
    envelopeFormat: diags.envelopeFormat,
    accountingMode: diags.accountingMode,
    ceilingLearnedAt: ceiling?.learnedAt ?? null,
    corruptKeyPresent: diags.corruptKey.present,
    corruptKeyBytes: diags.corruptKey.bytes,
    brimEscapes: diags.brimEscapes,
    bytesInUseTotal: bytes.total,
  };
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
