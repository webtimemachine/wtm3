import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WtmApiError } from "@wtm/shared/api";
import type { PageRecord, SearchHit } from "@wtm/shared";
import {
  DEFAULT_BACKEND,
  clientFor,
  loadSession,
  saveSession,
  snippetHtml,
  timeAgo,
  type Session,
} from "./session";

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());

  const onAuthed = useCallback((s: Session) => {
    saveSession(s);
    setSession(s);
  }, []);
  const onLogout = useCallback(() => {
    saveSession(null);
    setSession(null);
  }, []);

  return session ? (
    <Dashboard session={session} onLogout={onLogout} />
  ) : (
    <Auth onAuthed={onAuthed} />
  );
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function Auth({ onAuthed }: { onAuthed: (s: Session) => void }) {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BACKEND);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(register: boolean) {
    setError("");
    if (!email || !password) return setError("Email and password are required.");
    setBusy(true);
    try {
      const client = clientFor(baseUrl);
      const res = register
        ? await client.register({ email, password })
        : await client.login({ email, password });
      onAuthed({ baseUrl: baseUrl.replace(/\/+$/, ""), token: res.token, user: res.user });
    } catch (e) {
      setError(e instanceof WtmApiError ? e.message : `Could not reach ${baseUrl}`);
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="card">
        <h1 className="brand">
          Web Time <span className="dot">Machine</span>
        </h1>
        <p className="tagline">Search the readable text of every page you've visited.</p>

        <label>Backend URL</label>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={DEFAULT_BACKEND} />
        <label>Email</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        <label>Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password (8+ chars)"
          onKeyDown={(e) => e.key === "Enter" && submit(false)}
        />

        <div className="row">
          <button disabled={busy} onClick={() => submit(false)}>
            Log in
          </button>
          <button className="secondary" disabled={busy} onClick={() => submit(true)}>
            Create account
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function Dashboard({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const client = useMemo(() => clientFor(session.baseUrl, session.token), [session]);

  const [query, setQuery] = useState("");
  const [items, setItems] = useState<(PageRecord | SearchHit)[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [textFor, setTextFor] = useState<PageRecord | null>(null);
  const reqId = useRef(0);

  const loadRecent = useCallback(
    async (before?: number) => {
      const id = ++reqId.current;
      setLoading(true);
      setError("");
      try {
        const res = await client.recent({ limit: 30, before });
        if (id !== reqId.current) return;
        setTotal(null);
        setItems((prev) => (before ? [...prev, ...res.pages] : res.pages));
        setCursor(res.pages.length === 30 ? res.cursor : null);
      } catch (e) {
        if (id === reqId.current) handleErr(e);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [client],
  );

  const runSearch = useCallback(
    async (q: string) => {
      const id = ++reqId.current;
      setLoading(true);
      setError("");
      try {
        const res = await client.search(q, { limit: 50 });
        if (id !== reqId.current) return;
        setItems(res.hits);
        setTotal(res.total);
        setCursor(null);
      } catch (e) {
        if (id === reqId.current) handleErr(e);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [client],
  );

  function handleErr(e: unknown) {
    if (e instanceof WtmApiError && e.status === 401) {
      onLogout();
      return;
    }
    setError(e instanceof WtmApiError ? e.message : "Request failed.");
  }

  // debounce query -> recent | search
  useEffect(() => {
    const q = query.trim();
    const t = setTimeout(() => {
      if (q) void runSearch(q);
      else void loadRecent();
    }, 220);
    return () => clearTimeout(t);
  }, [query, runSearch, loadRecent]);

  async function del(id: string) {
    try {
      await client.deletePage(id);
      setItems((prev) => prev.filter((p) => p.id !== id));
      if (total != null) setTotal(total - 1);
    } catch (e) {
      handleErr(e);
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
        <button className="link" onClick={onLogout}>
          Log out
        </button>
      </header>

      <div className="searchbar">
        <input
          type="search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the full text of your history…"
        />
        <span className="count">
          {query.trim()
            ? total != null
              ? `${total} match${total === 1 ? "" : "es"}`
              : ""
            : "Recent"}
        </span>
      </div>

      {error && <div className="banner error">{error}</div>}

      <main className="list">
        {items.length === 0 && !loading && (
          <div className="empty">
            {query.trim() ? `No matches for “${query.trim()}”.` : "No pages captured yet."}
          </div>
        )}
        {items.map((p) => (
          <PageCard key={p.id} page={p} onDelete={() => del(p.id)} onViewText={() => setTextFor(p)} />
        ))}

        {loading && <div className="empty">Loading…</div>}
        {!query.trim() && cursor != null && !loading && (
          <button className="more" onClick={() => loadRecent(cursor)}>
            Load older
          </button>
        )}
      </main>

      {textFor && <TextModal client={client} page={textFor} onClose={() => setTextFor(null)} />}
    </div>
  );
}

function PageCard({
  page,
  onDelete,
  onViewText,
}: {
  page: PageRecord | SearchHit;
  onDelete: () => void;
  onViewText: () => void;
}) {
  const hit = page as SearchHit;
  return (
    <article className="hit">
      <a className="title" href={page.url} target="_blank" rel="noreferrer">
        {page.title || page.url}
      </a>
      {hit.snippet ? (
        <p className="snippet" dangerouslySetInnerHTML={{ __html: snippetHtml(hit.snippet) }} />
      ) : page.summary ? (
        <p className="summary">{page.summary}</p>
      ) : page.summaryStatus === "pending" ? (
        <p className="summary muted">Summarizing…</p>
      ) : null}
      <div className="meta">
        <span className="url" title={page.url}>
          {page.url}
        </span>
        <span className="pill">{timeAgo(page.visitedAt)}</span>
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
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    client
      .getText(page.id)
      .then((t) => alive && setText(t))
      .catch(() => alive && setErr("Could not load text."));
    return () => {
      alive = false;
    };
  }, [client, page.id]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <a href={page.url} target="_blank" rel="noreferrer" className="title">
            {page.title}
          </a>
          <button className="link" onClick={onClose}>
            Close
          </button>
        </header>
        {page.summary && <p className="summary">{page.summary}</p>}
        {err && <div className="error">{err}</div>}
        <pre className="fulltext">{text ?? (err ? "" : "Loading…")}</pre>
      </div>
    </div>
  );
}
