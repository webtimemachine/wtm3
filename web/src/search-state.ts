import type { SearchSort } from "@wtm/shared";
import type { SearchTimePreset } from "@wtm/shared/search";

export interface SearchState {
  query: string;
  timePreset: SearchTimePreset;
  customFrom: string;
  customTo: string;
  site: string;
  sort: SearchSort;
}

export function defaultSearchState(): SearchState {
  return {
    query: "",
    timePreset: "any",
    customFrom: "",
    customTo: "",
    site: "",
    sort: "relevance",
  };
}

export function readSearchState(url: URL): SearchState {
  const params = url.searchParams;
  const state = defaultSearchState();
  state.query = params.get("q") ?? "";
  state.site = params.get("site") ?? "";
  const time = params.get("time");
  if (
    time === "today" || time === "7d" || time === "30d" ||
    time === "1y" || time === "custom"
  ) state.timePreset = time;
  const sort = params.get("sort");
  if (sort === "newest" || sort === "oldest") state.sort = sort;
  if (state.timePreset === "custom") {
    state.customFrom = dateParam(params.get("from"));
    state.customTo = dateParam(params.get("through"));
  }
  return state;
}

function dateParam(value: string | null): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? value : "";
}

export function searchStateUrl(current: URL, state: SearchState): URL {
  const url = new URL(current);
  for (const key of ["q", "site", "time", "sort", "from", "through"])
    url.searchParams.delete(key);
  if (state.query.trim()) url.searchParams.set("q", state.query);
  if (state.site.trim()) url.searchParams.set("site", state.site);
  if (state.timePreset !== "any") url.searchParams.set("time", state.timePreset);
  if (state.sort !== "relevance") url.searchParams.set("sort", state.sort);
  if (state.timePreset === "custom") {
    if (state.customFrom) url.searchParams.set("from", state.customFrom);
    if (state.customTo) url.searchParams.set("through", state.customTo);
  }
  return url;
}

export function hasSearchFilters(state: SearchState): boolean {
  return state.timePreset !== "any" || !!state.site.trim() || state.sort !== "relevance";
}
