import type { SearchOptions } from "./index";

const DAY_MS = 86_400_000;

export type SearchTimePreset =
  | "any"
  | "today"
  | "7d"
  | "30d"
  | "1y"
  | "custom";

export const SEARCH_TIME_CHOICES: ReadonlyArray<{
  value: SearchTimePreset;
  label: string;
}> = [
  { value: "any", label: "Any time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "1y", label: "1 year" },
  { value: "custom", label: "Custom" },
];

function localDateStart(value: string, addDays = 0): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + addDays,
  );
  return Number.isFinite(date.getTime()) ? date.getTime() : undefined;
}

export function searchRangeForPreset(
  preset: SearchTimePreset,
  customFrom = "",
  customTo = "",
  now = Date.now(),
): Pick<SearchOptions, "from" | "to"> {
  if (preset === "custom") {
    return {
      from: localDateStart(customFrom),
      to: localDateStart(customTo, 1),
    };
  }
  if (preset === "any") return {};
  if (preset === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { from: start.getTime() };
  }
  const days = preset === "7d" ? 7 : preset === "30d" ? 30 : 365;
  return { from: now - days * DAY_MS };
}
