// Storage layer for the extension. Hard-won design constraints (all observed
// live on iOS Safari — see the 3.1.x storage regression coverage):
//
//  1. Safari charges storage in UTF-16 code units (2 bytes per ASCII char);
//     desktop browsers charge UTF-8. All budgets here are in PLATFORM BYTES.
//  2. At the quota brim, Safari double-counts old+new value while rewriting a
//     key, so EVERY set() fails — even a shrinking or empty write. Only
//     remove() recovers. safeSet() encodes that escape.
//  3. iOS kills extension contexts at any await. Every write must leave
//     storage in a state some future run can proceed from.
//  4. The background worker and popup are separate JS contexts. Locks here
//     are per-context, so ONLY the background may mutate storage (the popup
//     sends messages); reads are safe anywhere.
import type { CapturedPage } from "@wtm/shared";
import { DEFAULT_STATE, PLATFORM, type ExtState } from "./config";
import { gunzipFromB64, gzipToB64 } from "./gzip";

const STATE_KEY = "wtm:state";
const QUEUE_KEY = "wtm:queue";
const CEILING_KEY = "wtm:quotaCeiling";
const CORRUPT_KEY = "wtm:queue:corrupt";

// Queue budget in platform bytes. iOS field data puts the real per-extension
// ceiling around ~750KB platform bytes; 400KB leaves headroom for state and
// margin for error. Arithmetic to keep in mind before "optimizing": base64 is
// ASCII, so under UTF-16 accounting a gz payload costs 8/3 x the compressed
// binary size — 400KB platform bytes ~ 150KB of gzip ~ 0.5-1MB of raw page
// text ~ 100+ typical pages. Desktop quotas are 10MB+; 4MB is comfortable.
const QUEUE_SOFT_PLATFORM_BYTES = PLATFORM === "safari-ios" ? 400_000 : 4_000_000;

// Never learn a ceiling below this: isQuotaError is substring-broad, and one
// odd failed write must not park capture at a starvation budget forever.
const CEILING_FLOOR_BYTES = 65_536;
// A learned ceiling older than this is ignored on load — recovery path for a
// bogus learn; the platform's real limit doesn't move.
const CEILING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// One 200K-char longread costs ~130KB platform bytes even compressed — three
// of them would evict everything else from an iOS queue. Cap what the
// constrained device BUFFERS (the server-side record is separately capped).
const IOS_PAGE_TEXT_CAP = 60_000;

/** Size of a value as the current platform's storage accounting charges it. */
export function storedSize(value: unknown): number {
  const json = JSON.stringify(value);
  return PLATFORM === "safari-ios" ? json.length * 2 : new TextEncoder().encode(json).length;
}

export function isQuotaError(e: unknown): boolean {
  const s = `${(e as { message?: string } | null)?.message ?? e}`.toLowerCase();
  return s.includes("quota") || s.includes("exceeded");
}

/** Prefix an error with which operation hit it, preserving the original text. */
function tagError(op: string, e: unknown): Error {
  return new Error(`${op}: ${(e as { message?: string } | null)?.message ?? e}`);
}

function dropOldest(q: CapturedPage[], fraction: number): CapturedPage[] {
  return q.length <= 1 ? [] : q.slice(Math.max(1, Math.ceil(q.length * fraction)));
}

// ---------------------------------------------------------------------------
// The single storage mutex. EVERY read-modify-write of state or queue goes
// through this — and because only the background context calls the mutators
// below, a per-context lock is globally sufficient. Public mutators take the
// lock exactly once and only call the lock-free internals.
// ---------------------------------------------------------------------------

let storageLock: Promise<unknown> = Promise.resolve();
export function withStorageLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = storageLock.then(fn, fn);
  storageLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------------------------------------------------------------------------
// safeSet — the brim escape (constraint 2).
// ---------------------------------------------------------------------------

async function safeSet(key: string, value: unknown): Promise<void> {
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch (e) {
    if (!isQuotaError(e)) throw e;
    // Free the old value unconditionally, then the new one only has to fit on
    // its own. Crash window between remove and set loses only this key's old
    // value — for the queue that's the unsynced retry buffer (server upserts
    // are idempotent), for state ~1KB of re-derivable session data. Both are
    // strictly better than the permanent wedge this escapes.
    await chrome.storage.local.remove(key);
    await chrome.storage.local.set({ [key]: value });
  }
}

// ---------------------------------------------------------------------------
// Learned quota ceiling. Lives at its own tiny key — NEVER inside state, so
// persisting it can't clobber concurrent state patches. Learned in memory the
// moment a queue write fails; persisted only after a later SUCCESSFUL write
// (at failure time storage demonstrably has no room). Heals upward 10% after
// each fully-clean drain, and expires after 7 days.
// ---------------------------------------------------------------------------

type Ceiling = { bytes: number; learnedAt: number };
let ceiling: Ceiling | null = null;
let ceilingLoaded = false;
let ceilingDirty = false;

async function loadCeiling(): Promise<void> {
  if (ceilingLoaded) return;
  try {
    const o = await chrome.storage.local.get(CEILING_KEY);
    const c = o[CEILING_KEY] as Ceiling | undefined;
    if (
      c &&
      typeof c.bytes === "number" &&
      typeof c.learnedAt === "number" &&
      Date.now() - c.learnedAt < CEILING_TTL_MS &&
      ceiling === null // an in-memory learn from this session is fresher
    ) {
      ceiling = c;
    }
  } catch {
    /* unreadable — proceed with in-memory value */
  }
  ceilingLoaded = true;
}

function noteQuotaHit(platformBytes: number): void {
  const learned = Math.max(CEILING_FLOOR_BYTES, Math.floor(platformBytes * 0.75));
  if (!ceiling || learned < ceiling.bytes) {
    ceiling = { bytes: learned, learnedAt: Date.now() };
    ceilingDirty = true;
  }
}

async function persistCeilingIfDirty(): Promise<void> {
  if (!ceilingDirty || !ceiling) return;
  try {
    await chrome.storage.local.set({ [CEILING_KEY]: ceiling });
    ceilingDirty = false;
  } catch {
    /* best effort — stays dirty, retried after the next successful write */
  }
}

export async function getCeiling(): Promise<Ceiling | null> {
  await loadCeiling();
  return ceiling;
}

/** Called by the background after a drain that saw zero quota errors. */
export async function raiseCeilingAfterCleanDrain(): Promise<void> {
  await loadCeiling();
  if (!ceiling) return;
  const raised = Math.floor(ceiling.bytes * 1.1);
  if (raised >= QUEUE_SOFT_PLATFORM_BYTES) {
    ceiling = null;
    ceilingDirty = false;
    try {
      await chrome.storage.local.remove(CEILING_KEY);
    } catch {
      /* best effort */
    }
  } else {
    ceiling = { bytes: raised, learnedAt: ceiling.learnedAt };
    ceilingDirty = true;
    await persistCeilingIfDirty();
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export async function getState(): Promise<ExtState> {
  const o = await chrome.storage.local.get(STATE_KEY);
  return { ...DEFAULT_STATE, ...((o[STATE_KEY] as Partial<ExtState>) ?? {}) };
}

/**
 * The only way state is written (background context only — popup goes through
 * the setState message). Auth/device state outranks buffered captures: on
 * quota pressure, trim the queue to make room and retry; give up only once
 * the queue is empty and the state alone still won't fit.
 */
export function applyStatePatch(patch: Partial<ExtState>): Promise<ExtState> {
  return withStorageLock(async () => {
    await loadCeiling();
    const next = { ...(await getState()), ...patch };
    for (;;) {
      try {
        await safeSet(STATE_KEY, next);
        await persistCeilingIfDirty();
        return next;
      } catch (e) {
        if (!isQuotaError(e)) throw e;
        // Don't learn a ceiling from a ~1KB state write — queue writes learn
        // it from the payload that actually dominates storage.
        const read = await readQueueInternal();
        if (read.format === "corrupt") {
          await quarantineCorrupt(read.raw);
          continue; // removing the corrupt queue freed space; retry the state write
        }
        if (read.pages.length === 0) throw tagError("state write (queue already empty)", e);
        await writeQueueInternal(dropOldest(read.pages, 0.25));
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Queue. Stored as {v:2, n, gz} — n lets the popup show a count without
// gunzipping. Readers accept v2, v1 {v:1, gz}, and the pre-compression plain
// array. Reads NEVER write (popup safety); corrupt payloads are quarantined
// by the next background mutator instead of being silently overwritten.
// ---------------------------------------------------------------------------

type EnvelopeV2 = { v: 2; n: number; gz: string };
type QueueFormat = "v2" | "v1" | "plain" | "absent" | "corrupt";

function encodeQueue(pages: CapturedPage[]): EnvelopeV2 {
  return { v: 2, n: pages.length, gz: gzipToB64(JSON.stringify(pages)) };
}

async function readQueueInternal(): Promise<{ pages: CapturedPage[]; format: QueueFormat; raw?: unknown }> {
  const o = await chrome.storage.local.get(QUEUE_KEY);
  const raw = o[QUEUE_KEY];
  if (raw == null) return { pages: [], format: "absent" };
  if (Array.isArray(raw)) return { pages: raw as CapturedPage[], format: "plain" };
  const env = raw as { v?: number; gz?: string };
  if (typeof env === "object" && (env.v === 1 || env.v === 2) && typeof env.gz === "string") {
    try {
      return { pages: JSON.parse(gunzipFromB64(env.gz)) as CapturedPage[], format: env.v === 2 ? "v2" : "v1" };
    } catch {
      return { pages: [], format: "corrupt", raw };
    }
  }
  return { pages: [], format: "corrupt", raw };
}

/**
 * Preserve (don't silently destroy) an unreadable queue payload, then clear
 * the key so capture restarts cleanly. One-shot: the first corruption is the
 * recovery evidence; later ones just get cleared. Size-guarded so the
 * saved value cannot itself wedge a brim device.
 */
async function quarantineCorrupt(raw: unknown): Promise<void> {
  try {
    const existing = await chrome.storage.local.get(CORRUPT_KEY);
    await chrome.storage.local.remove(QUEUE_KEY); // free space FIRST (brim)
    if (existing[CORRUPT_KEY] != null) return;
    const budget = Math.min(QUEUE_SOFT_PLATFORM_BYTES, ceiling?.bytes ?? Number.POSITIVE_INFINITY);
    const value =
      storedSize(raw) <= budget * 0.25
        ? { at: Date.now(), raw }
        : { at: Date.now(), bytes: storedSize(raw), stub: true };
    await chrome.storage.local.set({ [CORRUPT_KEY]: value });
  } catch {
    try {
      await chrome.storage.local.remove(QUEUE_KEY);
    } catch {
      /* nothing more we can do */
    }
  }
}

/** Lock-free internal write: trim to budget, safeSet, learn ceiling on failure. */
async function writeQueueInternal(pages: CapturedPage[]): Promise<void> {
  await loadCeiling();
  const budget = Math.min(QUEUE_SOFT_PLATFORM_BYTES, ceiling?.bytes ?? Number.POSITIVE_INFINITY);
  let current = pages;
  let payload = encodeQueue(current);
  while (current.length > 1 && storedSize(payload) > budget) {
    current = dropOldest(current, 0.1);
    payload = encodeQueue(current);
  }
  for (;;) {
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

/** Read-only; safe from any context. Corrupt/absent read as empty. */
export async function getQueue(): Promise<CapturedPage[]> {
  return (await readQueueInternal()).pages;
}

/** Count without gunzipping the payload (popup status line). */
export async function getQueueCount(): Promise<number> {
  const o = await chrome.storage.local.get(QUEUE_KEY);
  const raw = o[QUEUE_KEY] as { v?: number; n?: number } | CapturedPage[] | undefined;
  if (raw == null) return 0;
  if (Array.isArray(raw)) return raw.length;
  if (raw.v === 2 && typeof raw.n === "number") return raw.n;
  return (await readQueueInternal()).pages.length;
}

/** Background only. Returns how many entries were added or refreshed. */
export function enqueue(pages: CapturedPage[]): Promise<number> {
  return withStorageLock(async () => {
    const read = await readQueueInternal();
    if (read.format === "corrupt") await quarantineCorrupt(read.raw);
    const q = read.format === "corrupt" ? [] : read.pages;

    const capped =
      PLATFORM === "safari-ios"
        ? pages.map((p) => (p.text.length > IOS_PAGE_TEXT_CAP ? { ...p, text: p.text.slice(0, IOS_PAGE_TEXT_CAP) } : p))
        : pages;

    // Dedupe by URL, replacing in place: a re-visit of a still-queued URL
    // keeps the queue position but carries the fresher text/visitedAt (the
    // old behavior DROPPED the newer capture).
    const indexByUrl = new Map(q.map((p, i) => [p.url, i] as const));
    const next = [...q];
    let changed = 0;
    for (const p of capped) {
      const i = indexByUrl.get(p.url);
      if (i === undefined) {
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

/** Background only: drop pages the server has acked. Migrates legacy formats. */
export function removeSyncedIds(ids: ReadonlySet<string>): Promise<void> {
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

/** Background only (popup sends the clearQueue message). remove() beats a
 * shrinking set() at the brim — see constraint 2. */
export function clearQueue(): Promise<void> {
  return withStorageLock(async () => {
    await chrome.storage.local.remove(QUEUE_KEY);
  });
}
