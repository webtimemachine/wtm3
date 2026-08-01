import { useCallback, useState } from "react";
import type { UserInfo } from "@wtm/shared";
import { Auth } from "./components/Auth";
import { Dashboard } from "./components/Dashboard";
import { ExtensionConnect } from "./components/ExtensionConnect";
import {
  DEFAULT_BACKEND,
  loadSession,
  saveSession,
  type Session,
} from "./session";

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const params = new URLSearchParams(window.location.search);
  const extensionRequest = params.get("connect");
  const requestedBackend = params.get("backend")?.trim() || DEFAULT_BACKEND;

  const replaceSession = useCallback((next: Session) => {
    saveSession(next);
    setSession(next);
  }, []);
  const logout = useCallback(() => {
    saveSession(null);
    setSession(null);
  }, []);
  const updateUser = useCallback((user: UserInfo) => {
    setSession((current) => {
      if (!current) return current;
      const next = { ...current, user };
      saveSession(next);
      return next;
    });
  }, []);

  if (extensionRequest) {
    return session ? (
      <ExtensionConnect
        session={session}
        requestId={extensionRequest}
        baseUrl={requestedBackend}
        onUseRequestedBackend={logout}
      />
    ) : (
      <Auth
        onAuthed={replaceSession}
        initialBaseUrl={requestedBackend}
        purpose="Sign in here once to connect your browser extension."
      />
    );
  }

  return session ? (
    <Dashboard
      session={session}
      onLogout={logout}
      onReplaceSession={replaceSession}
      onUpdateUser={updateUser}
    />
  ) : (
    <Auth onAuthed={replaceSession} />
  );
}
