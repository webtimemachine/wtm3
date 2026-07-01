import type { Env } from "./env";
import { reserveSeq } from "./db";

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
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return ADULT_DOMAINS.some((d) => h === d || h.endsWith("." + d));
  } catch {
    return false;
  }
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
export async function summarizeText(
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
            'sexually explicit, pornographic, or adult content, otherwise false>}.',
        },
        { role: "user", content: `Title: ${title}\nURL: ${url}\n\nContent:\n${body}` },
      ],
      max_tokens: 120,
    })) as { response?: unknown };

    // Workers AI may hand back `response` as a string OR as an already-parsed object.
    const r = res?.response;
    const text = typeof r === "string" ? r.trim() : "";
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
 * bumping each page's seq so it propagates on next pull.
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
    const seq = await reserveSeq(env, userId, 1);
    // Stale-write guard: only apply if the page still holds the content we analyzed
    // (a newer recapture changes content_hash). Bumping seq lets clients see the update.
    await env.DB.prepare(
      "UPDATE pages SET summary=?1, summary_status=?2, sensitive=?3, seq=?4, updated_at=?5 WHERE id=?6 AND user_id=?7 AND deleted=0 AND content_hash=?8",
    )
      .bind(summary, status, sensitive, seq, Date.now(), p.id, userId, p.contentHash)
      .run();
  }
}
