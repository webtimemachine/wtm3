// On-device page capture. Runs in a DOM context (content script / page) and
// extracts the readable text using Mozilla Readability, with a plain-text
// fallback. Pure-ish: it clones the document so the live page is never mutated.

import { Readability } from "@mozilla/readability";
import { MAX_TEXT_CHARS } from "./index";

export interface CaptureResult {
  title: string;
  text: string;
  excerpt: string | null;
  byline: string | null;
  lang: string | null;
}

// Re-exported for existing importers; the definition lives with the wire contract.
export { MAX_TEXT_CHARS };

// URL policy lives in ./url so the Worker can import it without DOM types.
export { isCapturableUrl, redactUrlCredentials } from "./url";

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
