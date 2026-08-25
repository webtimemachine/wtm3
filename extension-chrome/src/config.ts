import {
  DEFAULT_BACKEND,
  type ExtensionAuthScope,
  type Platform,
  type UserInfo,
} from "@wtm/shared";

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
  /** Separately approved read-only token for suggestions and Spotlight. */
  assistToken: string | null;
  assistEnabled: boolean;
  lastAssistError: string | null;
  user: UserInfo | null;
  deviceId: string | null;
  /** Which user id (on which backend) deviceId was registered under, as "baseUrl|userId". */
  deviceOwner: string | null;
  captureEnabled: boolean;
  /** iOS Safari only: redirect explicit `wtm ` / `!w ` submitted searches. */
  searchRouterEnabled: boolean;
  lastSync: number | null;
  lastError: string | null;
  /** When lastError was recorded; the popup stops showing errors after a TTL. */
  lastErrorAt: number | null;
  pendingConnection: {
    requestId: string;
    codeVerifier: string;
    expiresAt: number;
    baseUrl: string;
    scope?: ExtensionAuthScope;
  } | null;
  pendingAssistConnection: {
    requestId: string;
    codeVerifier: string;
    expiresAt: number;
    baseUrl: string;
    scope: "assist";
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
  assistToken: null,
  assistEnabled: false,
  lastAssistError: null,
  user: null,
  deviceId: null,
  deviceOwner: null,
  captureEnabled: true,
  searchRouterEnabled: false,
  lastSync: null,
  lastError: null,
  lastErrorAt: null,
  pendingConnection: null,
  pendingAssistConnection: null,
};
