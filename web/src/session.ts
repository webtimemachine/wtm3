import { WtmClient } from "@wtm/shared/api";
import { DEFAULT_BACKEND, type UserInfo } from "@wtm/shared";

export { DEFAULT_BACKEND };
const KEY = "wtm:web:session";

export interface Session {
  baseUrl: string;
  token: string;
  user: UserInfo;
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null): void {
  if (s) localStorage.setItem(KEY, JSON.stringify(s));
  else localStorage.removeItem(KEY);
}

export function clientFor(baseUrl: string, token?: string | null): WtmClient {
  return new WtmClient({ baseUrl, token: token ?? null });
}

// Shared with the extensions so escaping/formatting can't drift.
export { snippetHtml, timeAgo } from "@wtm/shared/format";
