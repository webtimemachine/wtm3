// Web Time Machine — shared wire-protocol types.
// This is the single source of truth for the contract between every client
// (Chrome extension, iOS Safari extension, web dashboard) and the Cloudflare backend.

export const API_VERSION = 1;

/** Production backend origin (clients allow overriding it at login). */
export const DEFAULT_BACKEND = "https://api.webtm.io";

/**
 * Per-page readable-text cap. Capture truncates to this on-device and the
 * backend clamps to the same value on push — one constant so they can't drift.
 */
export const MAX_TEXT_CHARS = 200_000;

/** History-retention bounds enforced by the backend; clients pre-validate. */
export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 3650;
export function isValidRetentionDays(d: number): boolean {
  return Number.isInteger(d) && d >= RETENTION_MIN_DAYS && d <= RETENTION_MAX_DAYS;
}

/** Platform identifier for a registered node (device). */
export type Platform = "chrome" | "safari-ios" | "web" | "cli" | string;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface RegisterRequest {
  email: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface UserInfo {
  id: string;
  email: string;
  createdAt: number;
  retentionDays: number;
  filterSensitive: boolean;
}

export interface SettingsUpdate {
  retentionDays?: number;
  filterSensitive?: boolean;
}

export interface AuthResponse {
  token: string;
  user: UserInfo;
}

// ---------------------------------------------------------------------------
// Nodes (devices)
// ---------------------------------------------------------------------------

export interface RegisterNodeRequest {
  /** Stable id chosen by the device; if omitted the server assigns one. */
  id?: string;
  name: string;
  platform: Platform;
}

export interface NodeInfo {
  id: string;
  name: string;
  platform: Platform;
  createdAt: number;
  lastSeenAt: number;
}

// ---------------------------------------------------------------------------
// Diagnostics — self-reported client state for support/debugging
// ---------------------------------------------------------------------------

/** A snapshot of local sync state a user (or the client itself) can report. */
export interface DiagnosticReport {
  platform: Platform;
  extensionVersion: string;
  /** Epoch ms when the snapshot was taken (device clock). */
  reportedAt: number;
  deviceId: string | null;
  queueLength: number;
  queueRawBytes: number;
  queueStoredBytes: number;
  /** The learned real-quota estimate storage.ts falls back to, if any. */
  quotaCeilingBytes: number | null;
  lastSync: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  /** Optional free-text note from the user describing what they saw. */
  note?: string;

  // --- v2 fields (3.2.0+; all optional so old clients keep validating) ---
  /** What fired this report: a user click, the auto-report on pause, or a queue clear. */
  trigger?: "user" | "auto" | "clear";
  /** Whether the context has CompressionStream (the original iOS mystery). */
  hasCompressionStream?: boolean;
  /** Stored queue format actually found: "v2" | "v1" | "plain" | "absent" | "corrupt". */
  envelopeFormat?: string;
  /** How this platform's storage is charged: "utf16" (Safari) or "utf8". */
  accountingMode?: string;
  /** When the learned quota ceiling was learned, if one is active. */
  ceilingLearnedAt?: number | null;
  corruptKeyPresent?: boolean;
  corruptKeyBytes?: number;
  /** How many times the remove-then-set brim escape fired this session. */
  brimEscapes?: number;
  bytesInUseTotal?: number | null;
}

// ---------------------------------------------------------------------------
// Pages — capture + sync
// ---------------------------------------------------------------------------

/** A page captured on a device, sent to the backend on push. */
export interface CapturedPage {
  /** Client-generated UUID. Doubles as the idempotency key and server id. */
  id: string;
  url: string;
  title: string;
  /** Epoch milliseconds when the page was visited on-device. */
  visitedAt: number;
  /** Readable text extracted on-device (Mozilla Readability). */
  text: string;
  excerpt?: string | null;
  byline?: string | null;
  lang?: string | null;
}

/** Summary generation lifecycle. */
export type SummaryStatus = "pending" | "ready" | "skipped" | "error";

/** Canonical server-side page record returned on pull / search. */
export interface PageRecord {
  id: string;
  url: string;
  title: string;
  visitedAt: number;
  capturedAt: number;
  summary: string | null;
  summaryStatus: SummaryStatus;
  excerpt: string | null;
  byline: string | null;
  lang: string | null;
  deviceId: string | null;
  /** Tombstone flag — deleted pages still sync so deletion propagates. */
  deleted: boolean;
  /** Per-user monotonic change sequence (sync cursor). */
  seq: number;
  /** Epoch ms at which retention will purge this record. */
  expiresAt: number | null;
  /** Whether the full readable text blob is available in object storage. */
  hasText: boolean;
  /** Flagged as adult/sensitive (hidden from views when the user's filter is on). */
  sensitive: boolean;
}

export interface SearchHit extends PageRecord {
  /** FTS snippet with <mark>…</mark> around matches. */
  snippet: string;
  /** BM25 rank (lower is a better match). */
  rank: number;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface SyncPushRequest {
  deviceId: string;
  pages: CapturedPage[];
  /** Page ids to tombstone (manual deletes originating on this device). */
  deletes?: string[];
}

export interface SyncPushResponse {
  accepted: number;
  deleted: number;
  /** Highest change seq after applying this push. */
  seq: number;
}

export interface SyncPullResponse {
  changes: PageRecord[];
  /** Pass this back as `since` on the next pull. */
  cursor: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
  total: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ApiError {
  error: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Routes (kept here so clients and server can't drift)
// ---------------------------------------------------------------------------

export interface RecentResponse {
  pages: PageRecord[];
  /** visited_at of the last item; pass as `before` to page backwards. */
  cursor: number | null;
}

export const Routes = {
  register: "/auth/register",
  login: "/auth/login",
  me: "/auth/me",
  settings: "/settings",
  nodes: "/nodes",
  node: (id: string) => `/nodes/${id}`,
  syncPush: "/sync/push",
  syncPull: "/sync/pull",
  search: "/search",
  recent: "/pages",
  page: (id: string) => `/pages/${id}`,
  pageText: (id: string) => `/pages/${id}/text`,
  diagnostics: "/diagnostics",
  health: "/health",
} as const;
