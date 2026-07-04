import { DEFAULT_BACKEND, type Platform, type UserInfo } from "@wtm/shared";

/** Default backend (production custom domain). Overridable in the popup. */
export { DEFAULT_BACKEND };

// Injected at build time via esbuild `define`.
declare const __WTM_PLATFORM__: string | undefined;
export const PLATFORM: Platform =
  typeof __WTM_PLATFORM__ !== "undefined" ? __WTM_PLATFORM__ : "chrome";

export interface ExtState {
  baseUrl: string;
  token: string | null;
  user: UserInfo | null;
  deviceId: string | null;
  /** Which user id (on which backend) deviceId was registered under, as "baseUrl|userId". */
  deviceOwner: string | null;
  captureEnabled: boolean;
  lastSync: number | null;
  lastError: string | null;
  /** When lastError was recorded; the popup stops showing errors after a TTL. */
  lastErrorAt: number | null;
  /** Rate limit for the automatic capture-paused diagnostic report. */
  lastAutoReportAt: number | null;
}

/** Key identifying which account a registered deviceId belongs to. */
export function deviceOwnerKey(baseUrl: string, userId: string): string {
  return `${baseUrl}|${userId}`;
}

export const DEFAULT_STATE: ExtState = {
  baseUrl: DEFAULT_BACKEND,
  token: null,
  user: null,
  deviceId: null,
  deviceOwner: null,
  captureEnabled: true,
  lastSync: null,
  lastError: null,
  lastErrorAt: null,
  lastAutoReportAt: null,
};
