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
import { APP_STORE_URL, CHROME_STORE_URL, GITHUB_URL, PRIVACY_URL } from "./links";

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
    <div className="landing">
      <section className="hero">
        <h1 className="brand">
          Web Time <span className="dot">Machine</span>
        </h1>
        <p className="tagline">
          Every page you visit — its full readable text — captured on your devices, searchable
          across all of them, each with a one-line AI summary. Private to your account.
        </p>
        <DownloadBadges />
      </section>

      <div className="card">
        <p className="card-title">Log in or create your account</p>

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

      <Footer />
    </div>
  );
}

function DownloadBadges() {
  return (
    <div className="badges">
      <a className="badge" href={APP_STORE_URL} target="_blank" rel="noreferrer">
        <AppleGlyph />
        <span>
          <small>Download on the</small>
          <b>App Store</b>
        </span>
      </a>
      {CHROME_STORE_URL ? (
        <a className="badge" href={CHROME_STORE_URL} target="_blank" rel="noreferrer">
          <ChromeGlyph />
          <span>
            <small>Add to</small>
            <b>Chrome</b>
          </span>
        </a>
      ) : (
        <span className="badge disabled" title="Coming soon to the Chrome Web Store">
          <ChromeGlyph />
          <span>
            <small>Coming soon to</small>
            <b>Chrome</b>
          </span>
        </span>
      )}
    </div>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <a href={PRIVACY_URL}>Privacy</a>
      <span className="sep">·</span>
      <a href={GITHUB_URL} target="_blank" rel="noreferrer">
        GitHub
      </a>
      <span className="sep">·</span>
      <span>Web Time Machine</span>
    </footer>
  );
}

function AppleGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor">
      <path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98C13.876.83 15.214.13 16.32.09c.03.13.045.28.045.43zM20.93 17.14c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8C3.94 18.38 3 15.57 3 12.92c0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.675.95 3.6.95.865 0 2.222-1.01 3.902-1.01.613 0 2.886.06 4.374 2.19-.13.09-2.383 1.37-2.383 4.19 0 3.26 2.854 4.42 2.955 4.45z" />
    </svg>
  );
}

function ChromeGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor">
      <circle cx="12" cy="12" r="10.5" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
      <path d="M12 7.5h9M12 16.5L7.5 8.6M12 16.5l4.5-7.9" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
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
