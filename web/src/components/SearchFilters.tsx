import type { SearchSort } from "@wtm/shared";
import {
  SEARCH_TIME_CHOICES,
  type SearchTimePreset,
} from "@wtm/shared/search";

export function SearchFilters({
  timePreset,
  onTimePreset,
  site,
  onSite,
  sort,
  onSort,
  customFrom,
  onCustomFrom,
  customTo,
  onCustomTo,
}: {
  timePreset: SearchTimePreset;
  onTimePreset: (value: SearchTimePreset) => void;
  site: string;
  onSite: (value: string) => void;
  sort: SearchSort;
  onSort: (value: SearchSort) => void;
  customFrom: string;
  onCustomFrom: (value: string) => void;
  customTo: string;
  onCustomTo: (value: string) => void;
}) {
  return (
    <section className="search-filters" aria-label="Search filters">
      <div className="time-options" role="group" aria-label="Time range">
        {SEARCH_TIME_CHOICES.map((choice) => (
          <button
            key={choice.value}
            type="button"
            className={timePreset === choice.value ? "active" : ""}
            aria-pressed={timePreset === choice.value}
            onClick={() => onTimePreset(choice.value)}
          >
            {choice.label}
          </button>
        ))}
      </div>

      <label className="filter-field site-filter">
        <span>Site</span>
        <input
          type="search"
          value={site}
          onChange={(event) => onSite(event.target.value)}
          placeholder="nytimes.com"
          autoComplete="off"
        />
      </label>

      <label className="filter-field sort-filter">
        <span>Sort</span>
        <select
          value={sort}
          onChange={(event) => onSort(event.target.value as SearchSort)}
        >
          <option value="relevance">Relevance</option>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </label>

      {timePreset === "custom" && (
        <div className="custom-dates">
          <label className="filter-field">
            <span>From</span>
            <input
              type="date"
              value={customFrom}
              onChange={(event) => onCustomFrom(event.target.value)}
            />
          </label>
          <label className="filter-field">
            <span>Through</span>
            <input
              type="date"
              value={customTo}
              onChange={(event) => onCustomTo(event.target.value)}
            />
          </label>
        </div>
      )}
    </section>
  );
}
