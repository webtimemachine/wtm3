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
  pages: { id: string; title: string; url: string; text: string }[],
): Promise<void> {
  for (const p of pages) {
    if (!p.text) {
      await env.DB.prepare(
        "UPDATE pages SET summary_status='skipped' WHERE id=?1 AND user_id=?2 AND deleted=0",
      )
        .bind(p.id, userId)
        .run();
      continue;
    }
    const summary = await summarizeText(env, p.title, p.url, p.text);
    const seq = await reserveSeq(env, userId, 1);
    await env.DB.prepare(
      "UPDATE pages SET summary=?1, summary_status=?2, seq=?3, updated_at=?4 WHERE id=?5 AND user_id=?6 AND deleted=0",
    )
      .bind(summary, summary ? "ready" : "error", seq, Date.now(), p.id, userId)
      .run();
  }
}
