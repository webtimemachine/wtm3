import type { CapturedPage } from "@wtm/shared";
import { DEFAULT_STATE, type ExtState } from "./config";

const STATE_KEY = "wtm:state";
const QUEUE_KEY = "wtm:queue";

// Safari Web Extensions cap storage.local far below Chrome and ignore the
// `unlimitedStorage` permission on iOS, so a queue of full-text captures can
// overflow it — especially while signed out, when flush() can't drain it. Keep
// the queue under a soft byte budget, and if storage.local.set still reports the
// quota exceeded, drop the oldest captures and retry so capture degrades
// gracefully instead of throwing "Exceeded storage quota".
const QUEUE_SOFT_BYTES = 4_000_000;

// The platform's real quota can sit far below QUEUE_SOFT_BYTES (iOS). Once a
// write fails we learn where the ceiling is: park the queue budget at 75% of
// the smallest payload seen failing, so state writes (token, deviceId, …)
// always have headroom instead of the queue filling storage to the brim.
// Module-level only — a restarted worker re-learns it on the next quota hit.
let quotaCeilingBytes: number | null = null;

function noteQuotaHit(failedBytes: number): void {
  const ceiling = Math.floor(failedBytes * 0.75);
  quotaCeilingBytes = quotaCeilingBytes === null ? ceiling : Math.min(quotaCeilingBytes, ceiling);
}

function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function isQuotaError(e: unknown): boolean {
  const s = `${(e as { message?: string } | null)?.message ?? e}`.toLowerCase();
  return s.includes("quota") || s.includes("exceeded");
}

function dropOldest(q: CapturedPage[], fraction: number): CapturedPage[] {
  return q.length <= 1 ? [] : q.slice(Math.max(1, Math.ceil(q.length * fraction)));
}

export async function getState(): Promise<ExtState> {
  const o = await chrome.storage.local.get(STATE_KEY);
  return { ...DEFAULT_STATE, ...((o[STATE_KEY] as Partial<ExtState>) ?? {}) };
}

export async function setState(patch: Partial<ExtState>): Promise<ExtState> {
  const next = { ...(await getState()), ...patch };
  // Auth/device state outranks buffered captures: if the write hits the
  // platform quota, drop the oldest queued captures to make room and retry,
  // giving up only once the queue is empty and the state alone still won't fit.
  for (;;) {
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

export async function getQueue(): Promise<CapturedPage[]> {
  const o = await chrome.storage.local.get(QUEUE_KEY);
  return (o[QUEUE_KEY] as CapturedPage[]) ?? [];
}

export async function setQueue(q: CapturedPage[]): Promise<void> {
  // Soft-trim the oldest captures until under the byte budget (the smaller of
  // the static soft budget and 75% of any observed real quota).
  const budget = Math.min(QUEUE_SOFT_BYTES, quotaCeilingBytes ?? Number.POSITIVE_INFINITY);
  let pages = q;
  while (pages.length > 1 && byteSize(pages) > budget) {
    pages = dropOldest(pages, 0.1);
  }
  // Write. If the platform's real quota is still exceeded, record where the
  // ceiling is, keep dropping the oldest captures, and retry; as a last resort
  // store an empty queue so capture never throws.
  for (;;) {
    try {
      await chrome.storage.local.set({ [QUEUE_KEY]: pages });
      return;
    } catch (e) {
      if (!isQuotaError(e) || pages.length === 0) throw e;
      noteQuotaHit(byteSize(pages));
      pages = dropOldest(pages, 0.25);
    }
  }
}

export async function enqueue(pages: CapturedPage[]): Promise<number> {
  const q = await getQueue();
  // De-dupe rapid re-captures of the same URL still sitting in the queue.
  const urls = new Set(q.map((p) => p.url));
  const fresh = pages.filter((p) => !urls.has(p.url));
  if (fresh.length) await setQueue([...q, ...fresh]);
  return fresh.length;
}
