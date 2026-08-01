import { useEffect, useState } from "react";
import {
  isValidRetentionDays,
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  type NodeInfo,
  type UserInfo,
} from "@wtm/shared";
import { WtmApiError } from "@wtm/shared/api";
import { clientFor, type Session } from "../session";

function errorMessage(caught: unknown): string {
  return caught instanceof WtmApiError
    ? caught.message
    : "Request failed.";
}

export function SettingsModal({
  client,
  session,
  onReplaceSession,
  onUpdateUser,
  onLogout,
  onClose,
}: {
  client: ReturnType<typeof clientFor>;
  session: Session;
  onReplaceSession: (session: Session) => void;
  onUpdateUser: (user: UserInfo) => void;
  onLogout: () => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState(session.user.filterSensitive);
  const [days, setDays] = useState(String(session.user.retentionDays));
  const [nodes, setNodes] = useState<NodeInfo[] | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    let alive = true;
    client
      .listNodes()
      .then((response) => alive && setNodes(response.nodes))
      .catch(() => alive && setNodes([]));
    return () => {
      alive = false;
    };
  }, [client]);

  function flash(message: string) {
    setSaved(message);
    window.setTimeout(() => setSaved(""), 1800);
  }

  async function toggleFilter() {
    const next = !filter;
    setFilter(next);
    setBusy(true);
    setError("");
    try {
      onUpdateUser(
        await client.updateSettings({ filterSensitive: next }),
      );
      flash("Saved");
    } catch (caught) {
      setFilter(!next);
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveRetention() {
    const value = Number.parseInt(days, 10);
    if (!isValidRetentionDays(value)) {
      setError(
        `Retention must be ${RETENTION_MIN_DAYS}–${RETENTION_MAX_DAYS} days.`,
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      onUpdateUser(
        await client.updateSettings({ retentionDays: value }),
      );
      flash("Saved");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function rename(id: string, name: string) {
    setError("");
    try {
      const updated = await client.renameNode(id, name.trim());
      setNodes(
        (current) =>
          current?.map((node) =>
            node.id === id ? updated : node,
          ) ?? current,
      );
      flash("Renamed");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function changePassword() {
    if (!currentPassword || newPassword.length < 8) {
      setError(
        "Enter your current password and a new password of at least 8 characters.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await client.changePassword({
        currentPassword,
        newPassword,
        client: "Web dashboard",
      });
      onReplaceSession({
        ...session,
        token: response.token,
        user: response.user,
      });
      setCurrentPassword("");
      setNewPassword("");
      flash("Password changed. Other sessions were logged out.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function logoutEverywhere() {
    if (
      !window.confirm(
        "Log out every Web Time Machine session and connected AI client?",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await client.logoutEverywhere();
      onLogout();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  async function deleteAccount() {
    if (!deletePassword) {
      setError("Enter your password to delete the account.");
      return;
    }
    if (
      !window.confirm(
        "Permanently delete your account and all captured pages? This cannot be undone.",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await client.deleteAccount({ password: deletePassword });
      onLogout();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <span className="title">Settings</span>
          <button className="link" onClick={onClose}>
            Close
          </button>
        </header>

        <section className="setting">
          <label className="toggle">
            <input
              type="checkbox"
              checked={filter}
              disabled={busy}
              onChange={() => void toggleFilter()}
            />
            <span>
              <b>Hide sensitive pages</b>
              <small>
                Keep adult / explicit pages out of your timeline and search.
              </small>
            </span>
          </label>
        </section>

        <section className="setting">
          <b>History expiration</b>
          <small>Captured pages auto-delete after this many days.</small>
          <div className="row">
            <input
              type="number"
              min={RETENTION_MIN_DAYS}
              max={RETENTION_MAX_DAYS}
              value={days}
              onChange={(event) => setDays(event.target.value)}
            />
            <span className="muted">days</span>
            <button
              className="btn"
              disabled={busy}
              onClick={() => void saveRetention()}
            >
              Save
            </button>
          </div>
        </section>

        <section className="setting">
          <b>Devices</b>
          <small>Rename any device.</small>
          <ul className="devices">
            {nodes == null ? (
              <li className="muted">Loading…</li>
            ) : !nodes.length ? (
              <li className="muted">
                No devices yet — sign in from the extension to register one.
              </li>
            ) : (
              nodes.map((node) => (
                <li key={node.id}>
                  <DeviceRow
                    node={node}
                    onRename={(name) => void rename(node.id, name)}
                  />
                </li>
              ))
            )}
          </ul>
        </section>

        <section className="setting">
          <b>Change password</b>
          <small>
            This logs out every other session and revokes connected AI
            clients.
          </small>
          <div className="security-grid">
            <input
              type="password"
              value={currentPassword}
              onChange={(event) =>
                setCurrentPassword(event.target.value)
              }
              placeholder="Current password"
            />
            <input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder="New password (8+ characters)"
            />
            <button
              className="btn"
              disabled={busy}
              onClick={() => void changePassword()}
            >
              Change password
            </button>
          </div>
        </section>

        <section className="setting">
          <b>Sessions</b>
          <small>
            Revoke every browser, extension, and connected AI client.
          </small>
          <button
            className="secondary compact"
            disabled={busy}
            onClick={() => void logoutEverywhere()}
          >
            Log out everywhere
          </button>
        </section>

        <section className="setting danger-zone">
          <b>Delete account</b>
          <small>
            Permanently deletes your account, page metadata, search index,
            and stored readable text.
          </small>
          <div className="security-grid">
            <input
              type="password"
              value={deletePassword}
              onChange={(event) =>
                setDeletePassword(event.target.value)
              }
              placeholder="Confirm your password"
            />
            <button
              className="secondary danger-button"
              disabled={busy}
              onClick={() => void deleteAccount()}
            >
              Delete account
            </button>
          </div>
        </section>

        {error && <div className="error">{error}</div>}
        {saved && <div className="saved">{saved}</div>}
      </div>
    </div>
  );
}

function DeviceRow({
  node,
  onRename,
}: {
  node: NodeInfo;
  onRename: (name: string) => void;
}) {
  const [name, setName] = useState(node.name);
  const dirty = name.trim() !== node.name && !!name.trim();
  return (
    <div className="device-row">
      <input
        value={name}
        maxLength={128}
        onChange={(event) => setName(event.target.value)}
      />
      <span className="platform">{node.platform}</span>
      <button
        className="btn"
        disabled={!dirty}
        onClick={() => onRename(name)}
      >
        Rename
      </button>
    </div>
  );
}
