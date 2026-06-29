import { WtmClient } from "@wtm/shared/api";
import type { UserInfo } from "@wtm/shared";

export const DEFAULT_BACKEND = "https://api.webtm.io";
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

/** Escape a server FTS snippet, preserving only the <mark> highlight tags. */
export function snippetHtml(s: string): string {
  const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replaceAll("&lt;mark&gt;", "<mark>").replaceAll("&lt;/mark&gt;", "</mark>");
}

export function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}
