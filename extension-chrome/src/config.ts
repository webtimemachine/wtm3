import { DEFAULT_BACKEND, type Platform, type UserInfo } from "@wtm/shared";

/** Default backend (production custom domain). Overridable in the popup. */
export { DEFAULT_BACKEND };

// Injected at build time via esbuild `define`.
declare const __WTM_PLATFORM__: string | undefined;
const injectedPlatform =
  typeof __WTM_PLATFORM__ !== "undefined" ? __WTM_PLATFORM__ : "chrome";
export const PLATFORM: Platform =
  injectedPlatform === "firefox-android" || injectedPlatform === "safari-ios"
    ? injectedPlatform
    : "chrome";

export interface ExtState {
  baseUrl: string;
  token: string | null;
  /** Set only for tokens minted by the website extension-approval flow. */
  tokenScope: "capture" | null;
  user: UserInfo | null;
  deviceId: string | null;
  /** Which user id (on which backend) deviceId was registered under, as "baseUrl|userId". */
  deviceOwner: string | null;
  captureEnabled: boolean;
  lastSync: number | null;
  lastError: string | null;
  /** When lastError was recorded; the popup stops showing errors after a TTL. */
  lastErrorAt: number | null;
  pendingConnection: {
    requestId: string;
    codeVerifier: string;
    expiresAt: number;
    baseUrl: string;
  } | null;
}

/** Key identifying which account a registered deviceId belongs to. */
export function deviceOwnerKey(baseUrl: string, userId: string): string {
  return `${baseUrl}|${userId}`;
}

export const DEFAULT_STATE: ExtState = {
  baseUrl: DEFAULT_BACKEND,
  token: null,
  tokenScope: null,
  user: null,
  deviceId: null,
  deviceOwner: null,
  captureEnabled: true,
  lastSync: null,
  lastError: null,
  lastErrorAt: null,
  pendingConnection: null,
};
