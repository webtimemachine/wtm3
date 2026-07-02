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

export function isQuotaError(e: unknown): boolean {
  const s = `${(e as { message?: string } | null)?.message ?? e}`.toLowerCase();
  return s.includes("quota") || s.includes("exceeded");
}

// --- queue compression -------------------------------------------------------
// Readable page text gzips ~3-5x, so storing the queue compressed multiplies
// how many captures fit under the platform quota (the win that matters on
// iOS). Values in storage.local must be JSON-safe, hence base64. Platforms
// without CompressionStream fall back to the legacy plain-array format, which
// getQueue still accepts.

const hasCompression =
  typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function gzipText(text: string): Promise<string> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return bufToB64(await new Response(stream).arrayBuffer());
}

async function gunzipText(b64: string): Promise<string> {
  const stream = new Blob([b64ToBytes(b64)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

type QueueEnvelope = { v: 1; gz: string };

async function encodeQueue(pages: CapturedPage[]): Promise<CapturedPage[] | QueueEnvelope> {
  if (!hasCompression) return pages;
  return { v: 1, gz: await gzipText(JSON.stringify(pages)) };
}

function dropOldest(q: CapturedPage[], fraction: number): CapturedPage[] {
  return q.length <= 1 ? [] : q.slice(Math.max(1, Math.ceil(q.length * fraction)));
}

/** Prefix an error with which operation hit it, preserving the original text. */
function tagError(op: string, e: unknown): Error {
  return new Error(`${op}: ${(e as { message?: string } | null)?.message ?? e}`);
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
      if (q.length === 0) throw tagError("state write (queue already empty)", e);
      noteQuotaHit(byteSize(next) + byteSize(q));
      await setQueue(dropOldest(q, 0.25));
    }
  }
}

export async function getQueue(): Promise<CapturedPage[]> {
  const o = await chrome.storage.local.get(QUEUE_KEY);
  const raw = o[QUEUE_KEY];
  if (Array.isArray(raw)) return raw as CapturedPage[]; // legacy / no-compression format
  if (raw && typeof raw === "object" && (raw as QueueEnvelope).v === 1) {
    try {
      return JSON.parse(await gunzipText((raw as QueueEnvelope).gz)) as CapturedPage[];
    } catch {
      return []; // corrupted envelope — drop the buffer rather than wedge capture
    }
  }
  return [];
}

export async function setQueue(q: CapturedPage[]): Promise<void> {
  // Soft-trim the oldest captures until the stored (compressed) payload is
  // under the byte budget (the smaller of the static soft budget and 75% of
  // any observed real quota).
  const budget = Math.min(QUEUE_SOFT_BYTES, quotaCeilingBytes ?? Number.POSITIVE_INFINITY);
  let pages = q;
  let payload = await encodeQueue(pages);
  while (pages.length > 1 && byteSize(payload) > budget) {
    pages = dropOldest(pages, 0.1);
    payload = await encodeQueue(pages);
  }
  // Write. If the platform's real quota is still exceeded, record where the
  // ceiling is, keep dropping the oldest captures, and retry; as a last resort
  // store an empty queue so capture never throws.
  for (;;) {
    try {
      await chrome.storage.local.set({ [QUEUE_KEY]: payload });
      return;
    } catch (e) {
      if (!isQuotaError(e)) throw e;
      if (pages.length === 0) throw tagError("queue write (even empty queue rejected)", e);
      noteQuotaHit(byteSize(payload));
      pages = dropOldest(pages, 0.25);
      payload = await encodeQueue(pages);
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
