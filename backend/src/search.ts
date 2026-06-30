// Build a safe FTS5 MATCH expression from free-form user input.
// Strategy: extract alphanumeric tokens, phrase-quote each (escapes punctuation
// so user input can't inject FTS operators), and prefix-match EVERY token. This
// maximizes recall — "compost" matches "composting", "nitro" matches "nitrogen" —
// while remaining fast (BM25 over the FTS index). Tokens are AND-ed together.

export function toMatchQuery(raw: string): string | null {
  const tokens = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" ");
}
