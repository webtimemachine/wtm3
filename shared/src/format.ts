// Small presentation helpers shared by the web dashboard and the extensions.

/** Search-as-you-type debounce, shared so both UIs feel identical. */
export const SEARCH_DEBOUNCE_MS = 220;

/** Display hostname of a URL ("www." stripped). Returns the input unchanged if it doesn't parse. */
export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Render a backend FTS snippet safely: HTML-escape everything, then re-enable
 * only the server's <mark>…</mark> highlight tags. Prevents captured page text
 * (which can contain arbitrary characters) from injecting markup.
 */
export function snippetHtml(s: string): string {
  const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replaceAll("&lt;mark&gt;", "<mark>").replaceAll("&lt;/mark&gt;", "</mark>");
}

/**
 * What to show under a result title. One shared precedence — search snippet,
 * then AI summary, then a "summary pending" placeholder — so the web dashboard
 * and the extension popups can't drift apart on the decision (the markup stays
 * per-platform).
 */
export type Subline =
  | { kind: "snippet"; value: string }
  | { kind: "summary"; value: string }
  | { kind: "pending" }
  | { kind: "none" };

export function chooseSubline(p: {
  snippet?: string;
  summary?: string | null;
  summaryStatus?: string;
}): Subline {
  if (p.snippet) return { kind: "snippet", value: p.snippet };
  if (p.summary) return { kind: "summary", value: p.summary };
  if (p.summaryStatus === "pending") return { kind: "pending" };
  return { kind: "none" };
}

/** Compact relative time, e.g. "just now", "5m ago", "3h ago", "2d ago". */
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
