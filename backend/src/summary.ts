import { hostname } from "@wtm/shared/format";
import type { Env } from "./env";

const MAX_INPUT_CHARS = 6000;

// Obvious adult sites flagged instantly at insert time (suffix match on hostname),
// so the most clear-cut cases are caught before the background AI pass runs.
const ADULT_DOMAINS = [
  "pornhub.com", "xvideos.com", "xnxx.com", "xhamster.com", "redtube.com", "youporn.com",
  "onlyfans.com", "brazzers.com", "chaturbate.com", "tnaflix.com", "spankbang.com",
  "stripchat.com", "porn.com", "por.com", "adultfriendfinder.com", "fansly.com",
];

/** Heuristic: is this URL on a well-known adult domain? */
export function isKnownAdultDomain(url: string): boolean {
  // hostname() passes non-URLs through unchanged — those must not match.
  const h = hostname(url);
  return h !== url && ADULT_DOMAINS.some((d) => h === d || h.endsWith("." + d));
}

function extractJson(s: string): { summary?: unknown; adult?: unknown } | null {
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

export interface PageAnalysis {
  summary: string | null;
  adult: boolean;
}

/**
 * One Workers AI call that returns both a one-line summary and an adult-content flag.
 * Robust to non-JSON output (falls back to treating the response as the summary).
 */
async function summarizeText(
  env: Env,
  title: string,
  url: string,
  text: string,
): Promise<PageAnalysis> {
  const body = text.slice(0, MAX_INPUT_CHARS);
  try {
    const res = (await env.AI.run(env.SUMMARY_MODEL as Parameters<Ai["run"]>[0], {
      messages: [
        {
          role: "system",
          content:
            'You analyze a web page and reply with ONLY compact JSON, no markdown, no extra text: ' +
            '{"summary": "<one concise sentence, max 25 words>", "adult": <true if the page is ' +
            // "/no_think" is Qwen3's soft switch to skip thinking mode; other models ignore it.
            'sexually explicit, pornographic, or adult content, otherwise false>}. /no_think',
        },
        { role: "user", content: `Title: ${title}\nURL: ${url}\n\nContent:\n${body}` },
      ],
      max_tokens: 256,
    })) as {
      response?: unknown;
      choices?: {
        message?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown };
      }[];
    };

    // Output shape varies by model: llama-family returns `response` (string or parsed
    // object); OpenAI-compatible models (qwen3, gpt-oss) return chat.completion
    // `choices[0].message.content` — and if thinking sneaks in, the JSON can land in
    // `reasoning`/`reasoning_content` instead of `content`.
    const msg = res?.choices?.[0]?.message;
    const r = res?.response ?? msg?.content ?? msg?.reasoning_content ?? msg?.reasoning;
    const text =
      typeof r === "string" ? r.replace(/<think>[\s\S]*?<\/think>/g, "").trim() : "";
    const j =
      r && typeof r === "object" && !Array.isArray(r)
        ? (r as { summary?: unknown; adult?: unknown })
        : extractJson(text);
    if (j && typeof j.summary === "string") {
      const s = j.summary.trim().replace(/^["']|["']$/g, "").slice(0, 280);
      return { summary: s || null, adult: j.adult === true };
    }
    // Fallback: no usable JSON — use the whole textual reply as the summary.
    const s = text.replace(/^["']|["']$/g, "").slice(0, 280);
    return { summary: s || null, adult: false };
  } catch (e) {
    console.error("summarize failed:", e instanceof Error ? e.message : String(e));
    return { summary: null, adult: false };
  }
}

/**
 * Background task: summarize + classify freshly-ingested pages and write the result back,
 * preserving a content-hash guard so a late result cannot overwrite a newer
 * recapture of the same page id.
 */
export async function summarizePages(
  env: Env,
  userId: string,
  pages: { id: string; title: string; url: string; text: string; contentHash: string }[],
): Promise<void> {
  for (const p of pages) {
    let summary: string | null = null;
    let adult = isKnownAdultDomain(p.url); // domain pre-check stands even without text
    if (p.text) {
      const a = await summarizeText(env, p.title, p.url, p.text);
      summary = a.summary;
      adult = adult || a.adult;
    }
    const status = !p.text ? "skipped" : summary ? "ready" : "error";
    const sensitive = adult ? 1 : 0;
    // Stale-write guard: only apply if the page still holds the content we analyzed
    // (a newer recapture changes content_hash).
    const written = await env.DB.prepare(
      "UPDATE pages SET summary=?1, summary_status=?2, sensitive=?3 WHERE id=?4 AND user_id=?5 AND content_hash=?6",
    )
      .bind(summary, status, sensitive, p.id, userId, p.contentHash)
      .run();
    // Mirror the summary into the search index. Shell-titled pages (YouTube,
    // dashboards) are often findable only by what the summary says about them.
    // Guarded by the same stale-write check: skip if the page moved on.
    if (summary && written.meta.changes > 0) {
      await env.DB.prepare(
        "UPDATE pages_fts SET summary=?1 WHERE page_id=?2 AND user_id=?3",
      )
        .bind(summary, p.id, userId)
        .run();
    }
  }
}
