import type { Env } from "./env";
import { reserveSeq } from "./db";

const MAX_INPUT_CHARS = 6000;

/** Generate a one-line summary for a page via Workers AI. Returns null on failure. */
export async function summarizeText(
  env: Env,
  title: string,
  url: string,
  text: string,
): Promise<string | null> {
  const body = text.slice(0, MAX_INPUT_CHARS);
  try {
    const res = (await env.AI.run(env.SUMMARY_MODEL as Parameters<Ai["run"]>[0], {
      messages: [
        {
          role: "system",
          content:
            "You summarize a web page in ONE concise sentence (max 25 words). " +
            "Output only the sentence — no preamble, no quotes, no markdown.",
        },
        {
          role: "user",
          content: `Title: ${title}\nURL: ${url}\n\nContent:\n${body}`,
        },
      ],
      max_tokens: 80,
    })) as { response?: string };

    const out = (res?.response ?? "").trim().replace(/^["']|["']$/g, "");
    return out ? out.slice(0, 280) : null;
  } catch (e) {
    console.error("summarize failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * Background task: summarize freshly-ingested pages and write the summary back,
 * bumping each page's seq so the summary propagates to other devices on next pull.
 */
export async function summarizePages(
  env: Env,
  userId: string,
  pages: { id: string; title: string; url: string; text: string; contentHash: string }[],
): Promise<void> {
  for (const p of pages) {
    const summary = p.text ? await summarizeText(env, p.title, p.url, p.text) : null;
    const status = !p.text ? "skipped" : summary ? "ready" : "error";
    const seq = await reserveSeq(env, userId, 1);
    // Stale-write guard: only apply if the page still holds the content we summarized.
    // A newer recapture changes content_hash (and resets summary_status to 'pending'),
    // so an older AI result can't clobber it. Bumping seq lets clients see the status.
    await env.DB.prepare(
      "UPDATE pages SET summary=?1, summary_status=?2, seq=?3, updated_at=?4 WHERE id=?5 AND user_id=?6 AND deleted=0 AND content_hash=?7",
    )
      .bind(summary, status, seq, Date.now(), p.id, userId, p.contentHash)
      .run();
  }
}
