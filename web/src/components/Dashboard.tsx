import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  PageRecord,
  SearchHit,
  UserInfo,
} from "@wtm/shared";
import { WtmApiError } from "@wtm/shared/api";
import {
  chooseSubline,
  hostname,
  SEARCH_DEBOUNCE_MS,
} from "@wtm/shared/format";
import { searchRangeForPreset } from "@wtm/shared/search";
import { groupByDay, type HistoryItem } from "../history";
import {
  defaultSearchState,
  hasSearchFilters,
  readSearchState,
  searchStateUrl,
  type SearchState,
} from "../search-state";
import {
  clientFor,
  snippetHtml,
  timeAgo,
  type Session,
} from "../session";
import { SettingsModal } from "./SettingsModal";
import { SearchFilters } from "./SearchFilters";

export function Dashboard({
  session,
  onLogout,
  onReplaceSession,
  onUpdateUser,
}: {
  session: Session;
  onLogout: () => void;
  onReplaceSession: (session: Session) => void;
  onUpdateUser: (user: UserInfo) => void;
}) {
  const client = useMemo(
    () => clientFor(session.baseUrl, session.token),
    [session.baseUrl, session.token],
  );
  const [search, setSearch] = useState(
    () => readSearchState(new URL(window.location.href)),
  );
  const { query, timePreset, customFrom, customTo, site, sort } = search;
  const searchRef = useRef(search);
  const editingField = useRef<"query" | "site" | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState("");
  const [textFor, setTextFor] = useState<PageRecord | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showTop, setShowTop] = useState(false);
  const requestId = useRef(0);
  const fetching = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  function updateSearch(patch: Partial<SearchState>, field?: "query" | "site") {
    const next = { ...searchRef.current, ...patch };
    if (patch.timePreset && patch.timePreset !== "custom") {
      next.customFrom = "";
      next.customTo = "";
    }
    const url = searchStateUrl(new URL(window.location.href), next);
    if (Object.keys(next).every((key) =>
      next[key as keyof SearchState] === searchRef.current[key as keyof SearchState],
    )) return;
    // One history entry per text edit, rather than one per keystroke.
    if (url.href !== window.location.href) {
      const method = field && editingField.current === field ? "replaceState" : "pushState";
      window.history[method](null, "", url);
      editingField.current = field ?? null;
    }
    searchRef.current = next;
    ++requestId.current;
    setSearch(next);
  }

  const handleError = useCallback(
    (caught: unknown) => {
      if (caught instanceof WtmApiError && caught.status === 401) {
        onLogout();
        return;
      }
      setError(
        caught instanceof WtmApiError ? caught.message : "Request failed.",
      );
    },
    [onLogout],
  );

  const runSearch = useCallback(
    async (state: SearchState, offset = 0) => {
      if (state !== searchRef.current || (offset > 0 && fetching.current)) return;
      const id = ++requestId.current;
      fetching.current = true;
      setLoading(true);
      setError("");
      const searchRange = searchRangeForPreset(
        state.timePreset, state.customFrom, state.customTo,
      );
      if (
        searchRange.from !== undefined &&
        searchRange.to !== undefined &&
        searchRange.from >= searchRange.to
      ) {
        setError("The start date must be before the end date.");
        fetching.current = false;
        setLoading(false);
        return;
      }
      try {
        const response = await client.search(state.query.trim(), {
          limit: 50,
          offset,
          ...searchRange,
          site: state.site,
          sort: state.sort,
        });
        if (id !== requestId.current || state !== searchRef.current) return;
        setItems((current) => offset ? [...current, ...response.hits] : response.hits);
        setTotal(response.total);
        const end = offset + response.hits.length;
        setNextOffset(response.hits.length && end < response.total ? end : null);
      } catch (caught) {
        if (id === requestId.current) handleError(caught);
      } finally {
        if (id === requestId.current) {
          fetching.current = false;
          setLoading(false);
        }
      }
    },
    [client, handleError],
  );

  useEffect(() => {
    ++requestId.current;
    fetching.current = false;
    setItems([]);
    setTotal(null);
    setNextOffset(null);
    setError("");
    setLoading(true);
    const timer = setTimeout(() => void runSearch(search), SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ++requestId.current;
    };
  }, [search, refresh, runSearch]);

  useEffect(() => {
    const restore = () => {
      const next = readSearchState(new URL(window.location.href));
      editingField.current = null;
      searchRef.current = next;
      ++requestId.current;
      setSearch(next);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  useEffect(() => {
    const element = sentinelRef.current;
    if (!element || query.trim() || nextOffset == null || error) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loading)
          void runSearch(search, nextOffset);
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [nextOffset, loading, query, search, error, runSearch]);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setShowTop(window.scrollY > 800);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  function backToLatest() {
    window.scrollTo({ top: 0, behavior: "smooth" });
    updateSearch(defaultSearchState());
    setRefresh((value) => value + 1);
  }

  async function deletePage(id: string) {
    const state = searchRef.current;
    try {
      await client.deletePage(id);
      if (state !== searchRef.current) return;
      setItems((current) => current.filter((page) => page.id !== id));
      setTotal((current) =>
        current === null ? current : Math.max(0, current - 1),
      );
      setNextOffset((current) =>
        current === null ? null : Math.max(0, current - 1),
      );
    } catch (caught) {
      handleError(caught);
    }
  }

  async function logout() {
    setLoggingOut(true);
    try {
      await client.logout();
    } catch {
      // Clear local credentials even when offline. Server-side sessions remain
      // revocable from another signed-in client with Log out everywhere.
    } finally {
      onLogout();
    }
  }

  return (
    <div className="app">
      <header>
        <span className="brand">
          Web Time <span className="dot">Machine</span>
        </span>
        <span className="spacer" />
        <span className="email">{session.user.email}</span>
        <button className="link" onClick={() => setShowSettings(true)}>
          Settings
        </button>
        <button
          className="link"
          disabled={loggingOut}
          onClick={() => void logout()}
        >
          Log out
        </button>
      </header>

      <form className="searchbar" onSubmit={(event) => {
        event.preventDefault();
        editingField.current = null;
        setRefresh((value) => value + 1);
      }}>
        <input
          type="search"
          name="q"
          autoFocus
          value={query}
          onChange={(event) => updateSearch({ query: event.target.value }, "query")}
          onBlur={() => { editingField.current = null; }}
          aria-label="Search the full text of your history"
          placeholder="Search the full text of your history…"
        />
        <span className="count">
          {total != null ? query.trim()
            ? `${total} match${total === 1 ? "" : "es"}`
            : `${total} page${total === 1 ? "" : "s"}` : ""}
        </span>
      </form>

      <SearchFilters
        timePreset={timePreset}
        onTimePreset={(timePreset) => updateSearch({ timePreset })}
        site={site}
        onSite={(site) => updateSearch({ site }, "site")}
        onSiteBlur={() => { editingField.current = null; }}
        sort={sort}
        onSort={(sort) => updateSearch({ sort })}
        customFrom={customFrom}
        onCustomFrom={(customFrom) => updateSearch({ customFrom })}
        customTo={customTo}
        onCustomTo={(customTo) => updateSearch({ customTo })}
        hasFilters={hasSearchFilters(search)}
        onClear={() => updateSearch({ ...defaultSearchState(), query })}
      />

      {error && <div className="banner error">{error}</div>}

      <main className="list">
        {!items.length && !loading && !error && (
          <div className="empty">
            {query.trim()
              ? `No matches for “${query.trim()}”.`
              : hasSearchFilters(search) ? "No pages match these filters." : "No pages captured yet."}
          </div>
        )}
        {query.trim()
          ? items.map((page) => (
              <PageCard
                key={page.id}
                page={page}
                onDelete={() => void deletePage(page.id)}
                onViewText={() => setTextFor(page)}
              />
            ))
          : groupByDay(items).map((group) => (
              <Fragment key={group.key}>
                <h2 className="day-header">{group.label}</h2>
                {group.pages.map((page) => (
                  <PageCard
                    key={page.id}
                    page={page}
                    onDelete={() => void deletePage(page.id)}
                    onViewText={() => setTextFor(page)}
                  />
                ))}
              </Fragment>
            ))}
        {loading && (
          <div className="empty">
            {items.length ? "Loading more…" : "Loading…"}
          </div>
        )}
        {nextOffset !== null && !loading && (
          <button className="load-more" onClick={() => void runSearch(search, nextOffset)}>
            Load more
          </button>
        )}
        {!query.trim() && (
          <div ref={sentinelRef} className="sentinel" aria-hidden="true" />
        )}
      </main>

      {showTop && (
        <button
          className="to-top"
          onClick={backToLatest}
          title="Back to the latest pages"
        >
          ↑ Latest
        </button>
      )}

      {textFor && (
        <TextModal
          client={client}
          page={textFor}
          onClose={() => setTextFor(null)}
        />
      )}
      {showSettings && (
        <SettingsModal
          client={client}
          session={session}
          onReplaceSession={onReplaceSession}
          onUpdateUser={(user) => {
            const filterChanged =
              user.filterSensitive !== session.user.filterSensitive;
            onUpdateUser(user);
            if (filterChanged) {
              setRefresh((value) => value + 1);
            }
          }}
          onLogout={onLogout}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

function PageCard({
  page,
  onDelete,
  onViewText,
}: {
  page: HistoryItem;
  onDelete: () => void;
  onViewText: () => void;
}) {
  const hit = page as SearchHit;
  const chosen = chooseSubline({
    snippet: hit.snippet,
    summary: page.summary,
    summaryStatus: page.summaryStatus,
  });
  const subline =
    chosen.kind === "snippet" ? (
      <p
        className="sub snippet"
        dangerouslySetInnerHTML={{ __html: snippetHtml(chosen.value) }}
      />
    ) : chosen.kind === "summary" ? (
      <p className="sub">{chosen.value}</p>
    ) : chosen.kind === "pending" ? (
      <p className="sub muted">Summarizing…</p>
    ) : null;

  return (
    <article className="hit">
      <div className="hit-row">
        <a
          className="title"
          href={page.url}
          target="_blank"
          rel="noreferrer"
        >
          {page.title || page.url}
        </a>
        <span className="host" title={page.url}>
          {hostname(page.url)}
        </span>
        <span className="time">{timeAgo(page.visitedAt)}</span>
      </div>
      {subline}
      <div className="hit-actions">
        {page.hasText && (
          <button className="link" onClick={onViewText}>
            View text
          </button>
        )}
        <button className="link danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </article>
  );
}

function TextModal({
  client,
  page,
  onClose,
}: {
  client: ReturnType<typeof clientFor>;
  page: PageRecord;
  onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    client
      .getText(page.id)
      .then((value) => alive && setText(value))
      .catch(() => alive && setError("Could not load text."));
    return () => {
      alive = false;
    };
  }, [client, page.id]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <a
            href={page.url}
            target="_blank"
            rel="noreferrer"
            className="title"
          >
            {page.title}
          </a>
          <button className="link" onClick={onClose}>
            Close
          </button>
        </header>
        {page.summary && <p className="summary">{page.summary}</p>}
        {error && <div className="error">{error}</div>}
        <pre className="fulltext">
          {text ?? (error ? "" : "Loading…")}
        </pre>
      </div>
    </div>
  );
}
