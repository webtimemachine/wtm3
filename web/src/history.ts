import type { PageRecord, SearchHit } from "@wtm/shared";

const DAY_MS = 86_400_000;
export type HistoryItem = PageRecord | SearchHit;

function dayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(ms: number): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  const difference = Math.round(
    (today.getTime() - date.getTime()) / DAY_MS,
  );
  if (difference === 0) return "Today";
  if (difference === 1) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function groupByDay(
  items: HistoryItem[],
): { key: string; label: string; pages: HistoryItem[] }[] {
  const groups: { key: string; label: string; pages: HistoryItem[] }[] = [];
  for (const page of items) {
    const key = dayKey(page.visitedAt);
    const last = groups[groups.length - 1];
    if (last?.key === key) last.pages.push(page);
    else
      groups.push({
        key,
        label: dayLabel(page.visitedAt),
        pages: [page],
      });
  }
  return groups;
}
