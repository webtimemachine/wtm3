import { useMemo, useState } from "react";
import { WtmApiError } from "@wtm/shared/api";
import {
  APP_STORE_URL,
  CHROME_STORE_URL,
  FIREFOX_STORE_URL,
  GITHUB_URL,
  PRIVACY_URL,
} from "../links";
import {
  DEFAULT_BACKEND,
  clientFor,
  type Session,
} from "../session";

export function Auth({
  onAuthed,
}: {
  onAuthed: (session: Session) => void;
}) {
  const resetToken = useMemo(
    () => new URLSearchParams(window.location.search).get("token") || "",
    [],
  );
  const [mode, setMode] = useState<"signin" | "forgot" | "reset">(
    resetToken ? "reset" : "signin",
  );
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BACKEND);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  function clearNotices() {
    setError("");
    setMessage("");
  }

  async function submit(register: boolean) {
    clearNotices();
    if (!email || !password)
      return setError("Email and password are required.");
    setBusy(true);
    try {
      const client = clientFor(baseUrl);
      const response = register
        ? await client.register({
            email,
            password,
            client: "Web dashboard",
          })
        : await client.login({
            email,
            password,
            client: "Web dashboard",
          });
      onAuthed({
        baseUrl: baseUrl.replace(/\/+$/, ""),
        token: response.token,
        user: response.user,
      });
    } catch (caught) {
      setError(
        caught instanceof WtmApiError
          ? caught.message
          : `Could not reach ${baseUrl}`,
      );
      setBusy(false);
    }
  }

  async function requestReset() {
    clearNotices();
    if (!email) return setError("Enter your email address.");
    setBusy(true);
    try {
      await clientFor(baseUrl).requestPasswordReset(email);
      setMessage(
        "If that account exists, a password-reset link is on its way.",
      );
    } catch (caught) {
      setError(
        caught instanceof WtmApiError
          ? caught.message
          : `Could not reach ${baseUrl}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirmReset() {
    clearNotices();
    if (password.length < 8)
      return setError("Password must be at least 8 characters.");
    if (password !== confirmPassword)
      return setError("The passwords do not match.");
    setBusy(true);
    try {
      await clientFor(baseUrl).confirmPasswordReset({
        token: resetToken,
        newPassword: password,
      });
      window.history.replaceState({}, "", "/");
      setPassword("");
      setConfirmPassword("");
      setMode("signin");
      setMessage("Password changed. Log in with your new password.");
    } catch (caught) {
      setError(
        caught instanceof WtmApiError
          ? caught.message
          : `Could not reach ${baseUrl}`,
      );
    } finally {
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
          Every page you visit — its full readable text — captured on your
          devices, searchable across all of them, each with a one-line AI
          summary. Private to your account.
        </p>
        <DownloadBadges />
      </section>

      <div className="card">
        {mode === "signin" && (
          <>
            <p className="card-title">Log in or create your account</p>
            <BackendField value={baseUrl} onChange={setBaseUrl} />
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
            />
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="password (8+ chars)"
              onKeyDown={(event) =>
                event.key === "Enter" && void submit(false)
              }
            />
            <div className="row">
              <button disabled={busy} onClick={() => void submit(false)}>
                Log in
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void submit(true)}
              >
                Create account
              </button>
            </div>
            <button
              className="text-button"
              onClick={() => {
                clearNotices();
                setMode("forgot");
              }}
            >
              Forgot password?
            </button>
          </>
        )}

        {mode === "forgot" && (
          <>
            <p className="card-title">Reset your password</p>
            <p className="card-copy">
              We’ll email a single-use link that expires in 30 minutes.
            </p>
            <BackendField value={baseUrl} onChange={setBaseUrl} />
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              onKeyDown={(event) =>
                event.key === "Enter" && void requestReset()
              }
            />
            <div className="row">
              <button disabled={busy} onClick={() => void requestReset()}>
                Send reset link
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  clearNotices();
                  setMode("signin");
                }}
              >
                Back
              </button>
            </div>
          </>
        )}

        {mode === "reset" && (
          <>
            <p className="card-title">Choose a new password</p>
            <BackendField value={baseUrl} onChange={setBaseUrl} />
            <label>New password</label>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="8+ characters"
            />
            <label>Confirm new password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              onKeyDown={(event) =>
                event.key === "Enter" && void confirmReset()
              }
            />
            <div className="row">
              <button disabled={busy} onClick={() => void confirmReset()}>
                Change password
              </button>
            </div>
          </>
        )}

        {error && <div className="error">{error}</div>}
        {message && <div className="success">{message}</div>}
      </div>
      <Footer />
    </div>
  );
}

function BackendField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <>
      <label>Backend URL</label>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={DEFAULT_BACKEND}
      />
    </>
  );
}

function DownloadBadges() {
  return (
    <div className="badges">
      <a
        className="badge"
        href={APP_STORE_URL}
        target="_blank"
        rel="noreferrer"
      >
        <AppleGlyph />
        <span>
          <small>Download on the</small>
          <b>App Store</b>
        </span>
      </a>
      <a
        className="badge"
        href={CHROME_STORE_URL}
        target="_blank"
        rel="noreferrer"
      >
        <ChromeGlyph />
        <span>
          <small>Add to</small>
          <b>Chrome</b>
        </span>
      </a>
      <a
        className="badge"
        href={FIREFOX_STORE_URL}
        target="_blank"
        rel="noreferrer"
      >
        <FirefoxGlyph />
        <span>
          <small>Add to</small>
          <b>Firefox</b>
        </span>
      </a>
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
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      aria-hidden="true"
      fill="currentColor"
    >
      <path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98C13.876.83 15.214.13 16.32.09c.03.13.045.28.045.43zM20.93 17.14c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8C3.94 18.38 3 15.57 3 12.92c0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.675.95 3.6.95.865 0 2.222-1.01 3.902-1.01.613 0 2.886.06 4.374 2.19-.13.09-2.383 1.37-2.383 4.19 0 3.26 2.854 4.42 2.955 4.45z" />
    </svg>
  );
}

function ChromeGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
    >
      <circle cx="12" cy="12" r="10.5" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
      <path
        d="M12 7.5h9M12 16.5L7.5 8.6M12 16.5l4.5-7.9"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FirefoxGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
    >
      <circle cx="12" cy="12" r="9.5" strokeWidth="1.6" />
      <path
        d="M7 9.5c1-2.2 3-3.4 5.2-3.2M16.8 8.2c.9 1.1 1.4 2.6 1.2 4.2-.4 3-3 5.1-6 4.9-2.4-.2-4.3-2-4.6-4.2-.2-1.5.6-2.9 1.9-3.2 1.1-.2 2.1.4 2.4 1.4"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
