// Web Time Machine — shared wire-protocol types.
// This is the single source of truth for the contract between every client
// (Chrome extension, iOS Safari extension, web dashboard) and the Cloudflare backend.

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
export type Platform = "chrome" | "firefox-android" | "safari-ios" | "web" | "cli";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface RegisterRequest {
  email: string;
  password: string;
  client?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  client?: string;
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

export type ExtensionAuthScope = "capture" | "assist";
export type SessionScope = "full" | ExtensionAuthScope;

export interface ExtensionAuthStartRequest {
  codeChallenge: string;
  client: string;
  /** Defaults to capture for backwards-compatible extension installs. */
  scope?: ExtensionAuthScope;
}

export interface ExtensionAuthStartResponse {
  requestId: string;
  expiresAt: number;
}

export interface ExtensionAuthRequestInfo {
  client: string;
  scope: ExtensionAuthScope;
  expiresAt: number;
  status: "pending" | "approved";
}

export interface ExtensionAuthExchangeRequest {
  requestId: string;
  codeVerifier: string;
}

export type ExtensionAuthExchangeResponse =
  | { status: "pending" }
  | ({ status: "connected"; scope: ExtensionAuthScope } & AuthResponse);

export interface PasswordChangeRequest {
  currentPassword: string;
  newPassword: string;
  client?: string;
}

export interface PasswordResetConfirmRequest {
  token: string;
  newPassword: string;
}

export interface AccountDeleteRequest {
  password: string;
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

export type SearchSort = "relevance" | "newest" | "oldest";

export interface SearchOptions {
  limit?: number;
  offset?: number;
  /** Inclusive visited-at lower bound, as epoch milliseconds. */
  from?: number;
  /** Exclusive visited-at upper bound, as epoch milliseconds. */
  to?: number;
  /** Hostname or URL. The backend includes matching subdomains. */
  site?: string;
  sort?: SearchSort;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface SyncPushRequest {
  deviceId: string;
  pages: CapturedPage[];
}

export interface SyncPushResponse {
  accepted: number;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
  total: number;
}

/** Metadata-only result intended for browser and OS suggestion surfaces. */
export interface HistorySuggestion {
  id: string;
  url: string;
  title: string;
  visitedAt: number;
}

export interface SuggestResponse {
  query: string;
  suggestions: HistorySuggestion[];
}

export interface IndexSnapshotResponse {
  version: string;
  generatedAt: number;
  items: HistorySuggestion[];
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
  logout: "/auth/logout",
  logoutEverywhere: "/auth/logout-everywhere",
  changePassword: "/auth/password",
  requestPasswordReset: "/auth/password-reset/request",
  confirmPasswordReset: "/auth/password-reset/confirm",
  extensionAuthStart: "/auth/extension/start",
  extensionAuthRequest: "/auth/extension/request",
  extensionAuthApprove: "/auth/extension/approve",
  extensionAuthToken: "/auth/extension/token",
  account: "/account",
  me: "/auth/me",
  settings: "/settings",
  nodes: "/nodes",
  node: (id: string) => `/nodes/${id}`,
  syncPush: "/sync/push",
  search: "/search",
  suggest: "/suggest",
  indexSnapshot: "/index-snapshot",
  recent: "/pages",
  page: (id: string) => `/pages/${id}`,
  pageText: (id: string) => `/pages/${id}/text`,
  health: "/health",
} as const;
