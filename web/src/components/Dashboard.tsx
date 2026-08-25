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
  SearchSort,
  UserInfo,
} from "@wtm/shared";
import { WtmApiError } from "@wtm/shared/api";
import {
  chooseSubline,
  hostname,
  SEARCH_DEBOUNCE_MS,
} from "@wtm/shared/format";
import {
  searchRangeForPreset,
  type SearchTimePreset,
} from "@wtm/shared/search";
import { groupByDay, type HistoryItem } from "../history";
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
  const [query, setQuery] = useState(
    () => new URLSearchParams(window.location.search).get("q") ?? "",
  );
  const [timePreset, setTimePreset] = useState<SearchTimePreset>("any");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [site, setSite] = useState("");
  const [sort, setSort] = useState<SearchSort>("relevance");
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState("");
  const [textFor, setTextFor] = useState<PageRecord | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showTop, setShowTop] = useState(false);
  const requestId = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const searchRange = useMemo(
    () => searchRangeForPreset(timePreset, customFrom, customTo),
    [timePreset, customFrom, customTo],
  );

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

  const loadRecent = useCallback(
    async (before?: number, append = false) => {
      const id = ++requestId.current;
      setLoading(true);
      setError("");
      try {
        const response = await client.recent({ limit: 30, before });
        if (id !== requestId.current) return;
        setTotal(null);
        setItems((current) =>
          append ? [...current, ...response.pages] : response.pages,
        );
        setCursor(response.pages.length === 30 ? response.cursor : null);
      } catch (caught) {
        if (id === requestId.current) handleError(caught);
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [client, handleError],
  );

  const runSearch = useCallback(
    async (value: string) => {
      const id = ++requestId.current;
      setLoading(true);
      setError("");
      if (
        searchRange.from !== undefined &&
        searchRange.to !== undefined &&
        searchRange.from >= searchRange.to
      ) {
        setError("The start date must be before the end date.");
        setLoading(false);
        return;
      }
      try {
        const response = await client.search(value, {
          limit: 50,
          ...searchRange,
          site,
          sort,
        });
        if (id !== requestId.current) return;
        setItems(response.hits);
        setTotal(response.total);
        setCursor(null);
      } catch (caught) {
        if (id === requestId.current) handleError(caught);
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [client, handleError, searchRange, site, sort],
  );

  useEffect(() => {
    const value = query.trim();
    const timer = setTimeout(() => {
      if (value) void runSearch(value);
      else void loadRecent();
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, runSearch, loadRecent]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const value = query.trim();
    if (value) url.searchParams.set("q", value);
    else url.searchParams.delete("q");
    window.history.replaceState(null, "", url);
  }, [query]);

  useEffect(() => {
    const element = sentinelRef.current;
    if (!element || query.trim() || cursor == null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loading)
          void loadRecent(cursor, true);
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [cursor, loading, query, loadRecent]);

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
    setQuery("");
    void loadRecent(undefined, false);
  }

  async function deletePage(id: string) {
    try {
      await client.deletePage(id);
      setItems((current) => current.filter((page) => page.id !== id));
      setTotal((current) =>
        current === null ? current : Math.max(0, current - 1),
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

      <form className="searchbar" action="/search" method="get">
        <input
          type="search"
          name="q"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search the full text of your history…"
        />
        <span className="count">
          {query.trim()
            ? total != null
              ? `${total} match${total === 1 ? "" : "es"}`
              : ""
            : "Recent"}
        </span>
      </form>

      <SearchFilters
        timePreset={timePreset}
        onTimePreset={setTimePreset}
        site={site}
        onSite={setSite}
        sort={sort}
        onSort={setSort}
        customFrom={customFrom}
        onCustomFrom={setCustomFrom}
        customTo={customTo}
        onCustomTo={setCustomTo}
      />

      {error && <div className="banner error">{error}</div>}

      <main className="list">
        {!items.length && !loading && (
          <div className="empty">
            {query.trim()
              ? `No matches for “${query.trim()}”.`
              : "No pages captured yet."}
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
            {items.length ? "Loading older…" : "Loading…"}
          </div>
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
              const value = query.trim();
              if (value) void runSearch(value);
              else void loadRecent(undefined, false);
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
