import { useEffect, useState } from "react";
import type { ExtensionAuthRequestInfo } from "@wtm/shared";
import { WtmApiError } from "@wtm/shared/api";
import { clientFor, type Session } from "../session";

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function ExtensionConnect({
  session,
  requestId,
  baseUrl,
  onUseRequestedBackend,
}: {
  session: Session;
  requestId: string;
  baseUrl: string;
  onUseRequestedBackend: () => void;
}) {
  const [request, setRequest] = useState<ExtensionAuthRequestInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState("");
  const backendMatches =
    normalizeBaseUrl(session.baseUrl) === normalizeBaseUrl(baseUrl);

  useEffect(() => {
    let active = true;
    void clientFor(baseUrl)
      .extensionAuthRequest(requestId)
      .then((response) => {
        if (!active) return;
        setRequest(response);
        setApproved(response.status === "approved");
      })
      .catch((caught) => {
        if (!active) return;
        setError(
          caught instanceof WtmApiError
            ? caught.message
            : `Could not reach ${baseUrl}`,
        );
      });
    return () => {
      active = false;
    };
  }, [baseUrl, requestId]);

  async function approve() {
    setBusy(true);
    setError("");
    try {
      await clientFor(baseUrl, session.token).approveExtensionAuth(requestId);
      setApproved(true);
    } catch (caught) {
      setError(
        caught instanceof WtmApiError
          ? caught.message
          : `Could not reach ${baseUrl}`,
      );
      setBusy(false);
    }
  }

  return (
    <div className="landing">
      <section className="hero compact-hero">
        <h1 className="brand">
          Web Time <span className="dot">Machine</span>
        </h1>
        <p className="tagline">Connect your browser without sharing a password.</p>
      </section>

      <div className="card connect-card">
        {error ? (
          <>
            <p className="card-title">Couldn’t connect this browser</p>
            <div className="error" role="alert">
              {error}
            </div>
            <a className="button-link secondary" href="/">
              Back to Web Time Machine
            </a>
          </>
        ) : !request ? (
          <p className="card-copy" role="status">
            Checking the connection request…
          </p>
        ) : approved ? (
          <>
            <p className="connect-check" aria-hidden="true">✓</p>
            <p className="card-title">Browser connected</p>
            <p className="card-copy">
              Return to {request.client} and reopen its popup. It can now upload
              captured pages, but it cannot search or change your account.
            </p>
            <a className="button-link" href="/">
              Continue to your history
            </a>
          </>
        ) : !backendMatches ? (
          <>
            <p className="card-title">Sign in to the requested server</p>
            <p className="card-copy">
              This connection uses <strong>{baseUrl}</strong>, but your current
              website session uses <strong>{session.baseUrl}</strong>.
            </p>
            <button type="button" onClick={onUseRequestedBackend}>
              Switch account
            </button>
          </>
        ) : (
          <>
            <p className="card-title">Connect {request.client}?</p>
            <p className="card-copy">
              Signed in as <strong>{session.user.email}</strong>. The extension
              will receive a separate token that can only identify this account
              and upload captured pages.
            </p>
            <div className="connection-scope">
              It cannot search your history, read saved pages, or change account
              settings.
            </div>
            <div className="row">
              <button type="button" disabled={busy} onClick={() => void approve()}>
                Allow connection
              </button>
              <a className="button-link secondary" href="/">
                Cancel
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
