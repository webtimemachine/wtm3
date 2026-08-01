import type { SearchSort } from "@wtm/shared";

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

export function normalizeSiteFilter(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const input = value.trim().toLowerCase();
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    const hostname = url.hostname.replace(/^www\./, "").replace(/\.$/, "");
    return hostname && /^[a-z0-9.-]+$/.test(hostname) && !hostname.includes("..")
      ? hostname
      : null;
  } catch {
    return null;
  }
}

export function parseSearchBoundary(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseSearchSort(value: unknown): SearchSort | null {
  return value === "relevance" || value === "newest" || value === "oldest"
    ? value
    : null;
}

export function searchOrder(sort: SearchSort, alias = "p"): string {
  if (sort === "newest") return `${alias}.visited_at DESC, rank`;
  if (sort === "oldest") return `${alias}.visited_at ASC, rank`;
  return `rank, ${alias}.visited_at DESC`;
}

export function addSearchFilters(
  conditions: string[],
  bindings: unknown[],
  filters: { from: number | null; to: number | null; site: string | null },
  alias = "p",
): void {
  if (filters.from !== null) {
    bindings.push(filters.from);
    conditions.push(`${alias}.visited_at >= ?${bindings.length}`);
  }
  if (filters.to !== null) {
    bindings.push(filters.to);
    conditions.push(`${alias}.visited_at < ?${bindings.length}`);
  }
  if (filters.site) {
    bindings.push(`%://${filters.site}/%`, `%://%.${filters.site}/%`);
    conditions.push(
      `(lower(${alias}.url) LIKE ?${bindings.length - 1} OR lower(${alias}.url) LIKE ?${bindings.length})`,
    );
  }
}
