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

function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function isQuotaError(e: unknown): boolean {
  const s = `${(e as { message?: string } | null)?.message ?? e}`.toLowerCase();
  return s.includes("quota") || s.includes("exceeded");
}

export async function getState(): Promise<ExtState> {
  const o = await chrome.storage.local.get(STATE_KEY);
  return { ...DEFAULT_STATE, ...((o[STATE_KEY] as Partial<ExtState>) ?? {}) };
}

export async function setState(patch: Partial<ExtState>): Promise<ExtState> {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
}

export async function getQueue(): Promise<CapturedPage[]> {
  const o = await chrome.storage.local.get(QUEUE_KEY);
  return (o[QUEUE_KEY] as CapturedPage[]) ?? [];
}

export async function setQueue(q: CapturedPage[]): Promise<void> {
  // Soft-trim the oldest captures until under the byte budget.
  let pages = q;
  while (pages.length > 1 && byteSize(pages) > QUEUE_SOFT_BYTES) {
    pages = pages.slice(Math.max(1, Math.ceil(pages.length * 0.1)));
  }
  // Write. If the platform's real quota is still exceeded, keep dropping the
  // oldest captures and retry; as a last resort store an empty queue so capture
  // never throws.
  for (;;) {
    try {
      await chrome.storage.local.set({ [QUEUE_KEY]: pages });
      return;
    } catch (e) {
      if (!isQuotaError(e) || pages.length === 0) throw e;
      pages = pages.length === 1 ? [] : pages.slice(Math.max(1, Math.ceil(pages.length * 0.25)));
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
