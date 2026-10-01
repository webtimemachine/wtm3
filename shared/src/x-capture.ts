import { MAX_TEXT_CHARS } from "./index";
import type { CaptureResult } from "./capture";

export interface XPostCapture extends CaptureResult {
  url: string;
}

const X_HOSTS = new Set([
  "x.com", "www.x.com", "mobile.x.com",
  "twitter.com", "www.twitter.com", "mobile.twitter.com",
]);
const POST_SELECTOR = 'article, [data-testid="tweet"]';
const QUOTE_SELECTOR = '[data-testid="quoteTweet"], [data-testid="card.wrapper"], div[role="link"]';

export function isXPageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && X_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function canCapturePosts(url: string): boolean {
  if (!isXPageUrl(url)) return false;
  const path = new URL(url).pathname;
  return !/^\/(?:compose|messages|settings|login|logout)(?:\/|$)/i.test(path)
    && !/^\/i\/(?:chat|flow|jf)(?:\/|$)/i.test(path);
}

function clean(text: string): string {
  return text.replace(/[ \t\f\v]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// Emoji are images in some X layouts. textContent alone silently drops them.
function readableText(node: Node): string {
  if (node.nodeType === 3) return node.textContent || "";
  if (node.nodeType !== 1) return "";
  const element = node as Element;
  if (element.matches('[hidden], [aria-hidden="true"]')) return "";
  if (element.tagName === "IMG") return element.getAttribute("alt") || "";
  if (element.tagName === "BR") return "\n";
  return [...element.childNodes].map(readableText).join("");
}

function ownElements(post: Element, selector: string): Element[] {
  return [...post.querySelectorAll(selector)].filter((element) => {
    if (element.closest(POST_SELECTOR) !== post) return false;
    const quote = element.closest(QUOTE_SELECTOR);
    return !quote || !post.contains(quote);
  });
}

function permalink(link: Element, pageUrl: string): { url: string; handle: string } | null {
  try {
    const parsed = new URL(link.getAttribute("href") || "", pageUrl);
    if (!isXPageUrl(parsed.href)) return null;
    const match = /^\/([a-z0-9_]{1,15})\/status\/(\d+)(?:\/|$)/i.exec(parsed.pathname);
    if (!match) return null;
    return { url: `https://x.com/${match[1]}/status/${match[2]}`, handle: match[1]! };
  } catch {
    return null;
  }
}

function capturePost(post: Element, pageUrl: string, lang: string | null): XPostCapture | null {
  const links = ownElements(post, "a[href]");
  // Prefer the timestamp, never a link in a quoted post or in the post body.
  // Public X pages also use timestamp anchors without a <time> element.
  const candidates = links.filter((link) => link.querySelector("time")
    || link.hasAttribute("data-base-ui-tooltip-trigger")
    || link.closest('[data-testid="User-Name"]'));
  const timestampLink = candidates.find((link) => permalink(link, pageUrl));
  if (!timestampLink) return null;
  const identity = permalink(timestampLink, pageUrl)!;

  let displayName = "";
  for (const link of links) {
    let path: string;
    try { path = new URL(link.getAttribute("href")!, pageUrl).pathname; }
    catch { continue; }
    if (path.toLowerCase() !== `/${identity.handle.toLowerCase()}`) continue;
    const label = clean(readableText(link));
    if (label && !label.startsWith("@")) {
      displayName = label;
      break;
    }
  }
  const byline = displayName ? `${displayName} (@${identity.handle})` : `@${identity.handle}`;

  let bodies = ownElements(post, '[data-testid="tweetText"]');
  // The newer public layout has no test IDs; its post body has dir="auto".
  if (!bodies.length) bodies = ownElements(post, '[dir="auto"].whitespace-pre-wrap').filter((element) =>
    !element.closest("a, button"));
  const body = bodies.map((element) => clean(readableText(element))).filter(Boolean).join("\n\n");
  const photos = ownElements(post, '[data-testid="tweetPhoto"] img, img[src*="pbs.twimg.com/media/"]');
  const media = photos.map((image) => {
    const alt = clean(image.getAttribute("alt") || "");
    return alt && !/^(?:image|photo)$/i.test(alt) ? `Photo: ${alt}` : "[Photo]";
  });
  if (ownElements(post, 'video, [data-testid="videoPlayer"]').length) media.push("[Video]");
  const content = [body, ...new Set(media)].filter(Boolean).join("\n\n");
  if (!content) return null; // A title, timestamp, or loading shell isn't a post.

  const time = timestampLink.querySelector("time");
  const posted = time?.getAttribute("datetime") || clean(readableText(timestampLink));
  return {
    url: identity.url,
    title: `${byline} on X: ${clean(content).slice(0, 180)}`,
    text: [byline, posted ? `Posted: ${posted}` : "", content].filter(Boolean).join("\n\n").slice(0, MAX_TEXT_CHARS),
    excerpt: content.slice(0, 280),
    byline,
    lang,
  };
}

/** Extract individual posts; never fall back to a whole feed or X's UI shell. */
export function captureXPostsFromDocument(
  doc: Document,
  pageUrl: string,
  isVisible: (post: Element) => boolean,
): XPostCapture[] {
  if (!canCapturePosts(pageUrl)) return [];
  const captures = new Map<string, XPostCapture>();
  for (const post of doc.querySelectorAll(POST_SELECTOR)) {
    if (!isVisible(post)) continue;
    const capture = capturePost(post, pageUrl, doc.documentElement.getAttribute("lang") || null);
    if (capture && (captures.get(capture.url)?.text.length ?? 0) < capture.text.length) {
      captures.set(capture.url, capture);
    }
  }
  return [...captures.values()];
}
