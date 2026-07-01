// On-device page capture. Runs in a DOM context (content script / page) and
// extracts the readable text using Mozilla Readability, with a plain-text
// fallback. Pure-ish: it clones the document so the live page is never mutated.

import { Readability } from "@mozilla/readability";

export interface CaptureResult {
  title: string;
  text: string;
  excerpt: string | null;
  byline: string | null;
  lang: string | null;
}

/** Max characters of readable text we keep per page. Keeps payloads sane. */
export const MAX_TEXT_CHARS = 200_000;

const SKIP_URL_SCHEMES = ["about:", "chrome:", "chrome-extension:", "moz-extension:", "edge:", "view-source:", "devtools:"];

/** Heuristic: should this URL be captured at all? */
export function isCapturableUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
  return !SKIP_URL_SCHEMES.some((s) => lower.startsWith(s));
}

function collapseWhitespace(s: string): string {
  return s.replace(/[ \t\f\v]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Extract readable content from a Document.
 * Returns null when the page yields no usable text (e.g. an empty SPA shell).
 */
export function capturePageFromDocument(doc: Document): CaptureResult | null {
  const lang = doc.documentElement.getAttribute("lang") || null;
  let title = (doc.title || "").trim();
  let text = "";
  let excerpt: string | null = null;
  let byline: string | null = null;

  try {
    // Readability mutates the document it parses — give it a throwaway clone.
    const clone = doc.cloneNode(true) as Document;
    const article = new Readability(clone, { charThreshold: 200 }).parse();
    if (article) {
      title = (article.title || title).trim();
      text = collapseWhitespace(article.textContent || "");
      excerpt = article.excerpt ? article.excerpt.trim() : null;
      byline = article.byline ? article.byline.trim() : null;
    }
  } catch {
    // fall through to the plain-text fallback below
  }

  if (!text) {
    const body = doc.body;
    text = collapseWhitespace(body ? body.innerText || body.textContent || "" : "");
  }

  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
  if (!text && !title) return null;

  return { title: title || "(untitled)", text, excerpt, byline, lang };
}
