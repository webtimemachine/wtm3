import type { CapturedPage } from "@wtm/shared";
import { DEFAULT_STATE, type ExtState } from "./config";

const STATE_KEY = "wtm:state";
const QUEUE_KEY = "wtm:queue";

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
  await chrome.storage.local.set({ [QUEUE_KEY]: q });
}

export async function enqueue(pages: CapturedPage[]): Promise<number> {
  const q = await getQueue();
  // De-dupe rapid re-captures of the same URL still sitting in the queue.
  const urls = new Set(q.map((p) => p.url));
  const fresh = pages.filter((p) => !urls.has(p.url));
  if (fresh.length) await setQueue([...q, ...fresh]);
  return fresh.length;
}
