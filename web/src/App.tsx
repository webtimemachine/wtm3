import { useCallback, useState } from "react";
import type { UserInfo } from "@wtm/shared";
import { Auth } from "./components/Auth";
import { Dashboard } from "./components/Dashboard";
import {
  loadSession,
  saveSession,
  type Session,
} from "./session";

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());

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
