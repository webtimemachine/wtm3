import { WtmApiError, WtmClient } from "@wtm/shared/api";
import { createPkcePair } from "@wtm/shared/auth";
import { timeAgo } from "@wtm/shared/format";
import { DEFAULT_BACKEND, PLATFORM, type ExtState } from "./config";
import { getQueueCount, getState } from "./storage";

const app = document.getElementById("app") as HTMLDivElement;
const DASHBOARD_URL = "https://webtm.io/";

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<Record<string, string>> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === "class") element.className = value;
    else if (key === "html") element.innerHTML = value;
    else element.setAttribute(key, value);
  }
  for (const child of children) element.append(child);
  return element;
}

async function client(): Promise<WtmClient> {
  const state = await getState();
  return new WtmClient({ baseUrl: state.baseUrl, token: state.token });
}

// The popup never writes storage directly. The background worker is the
// single writer, so its storage mutex also protects popup-triggered changes.
async function sendBg<T = { ok: boolean; error?: string; state?: ExtState }>(
  message: unknown,
): Promise<T> {
  const attempt = () => chrome.runtime.sendMessage(message) as Promise<T>;
  try {
    return await attempt();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return attempt();
  }
}

async function mutate(
  patch: Partial<ExtState>,
  opts: { thenFlush?: boolean } = {},
): Promise<ExtState> {
  const response = await sendBg<{
    ok: boolean;
    error?: string;
    state?: ExtState;
  }>({
    type: "setState",
    patch,
    thenFlush: opts.thenFlush,
  });
  if (!response?.ok || !response.state) {
    throw new Error(response?.error ?? "Couldn't save — try again.");
  }
  return response.state;
}

function extensionClientName():
  | "Chrome extension"
  | "Firefox extension"
  | "Safari extension" {
  if (PLATFORM === "safari-ios") return "Safari extension";
  if (PLATFORM === "firefox-android") return "Firefox extension";
  return "Chrome extension";
}

type PendingConnection = NonNullable<ExtState["pendingConnection"]>;

function connectionUrl(pending: PendingConnection): string {
  const url = new URL(DASHBOARD_URL);
  url.searchParams.set("connect", pending.requestId);
  if (pending.baseUrl.replace(/\/+$/, "") !== DEFAULT_BACKEND) {
    url.searchParams.set("backend", pending.baseUrl);
  }
  return url.toString();
}

function brandHeader(): HTMLElement {
  return h("header", {}, [
    h("span", {
      class: "brand",
      html: 'Web Time <span class="dot">Machine</span>',
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Logged-out / connection views
// ---------------------------------------------------------------------------

async function renderAuth(errorMessage?: string): Promise<void> {
  let state = await getState();
  const pending = state.pendingConnection;

  if (pending && pending.expiresAt <= Date.now()) {
    state = await mutate({ pendingConnection: null });
    errorMessage = "That connection request expired. Start a new one.";
  }

  if (!state.pendingConnection) {
    renderConnectStart(state, errorMessage);
    return;
  }

  try {
    const response = await new WtmClient({
      baseUrl: state.pendingConnection.baseUrl,
    }).exchangeExtensionAuth({
      requestId: state.pendingConnection.requestId,
      codeVerifier: state.pendingConnection.codeVerifier,
    });
    if (response.status === "connected") {
      await mutate(
        {
          baseUrl: state.pendingConnection.baseUrl,
          token: response.token,
          user: response.user,
          pendingConnection: null,
          lastError: null,
          lastErrorAt: null,
        },
        { thenFlush: true },
      );
      await renderApp();
      return;
    }
    renderPending(state.pendingConnection, errorMessage);
  } catch (caught) {
    if (
      caught instanceof WtmApiError &&
      (caught.status === 404 || caught.status === 410)
    ) {
      const next = await mutate({ pendingConnection: null });
      renderConnectStart(next, caught.message);
      return;
    }
    renderPending(
      state.pendingConnection,
      caught instanceof WtmApiError
        ? caught.message
        : `Could not reach ${state.pendingConnection.baseUrl}`,
    );
  }
}

function renderConnectStart(state: ExtState, errorMessage?: string): void {
  app.replaceChildren();
  const backend = h("input", {
    type: "url",
    id: "backend",
    name: "backend",
    autocomplete: "url",
    required: "",
    value: state.baseUrl || DEFAULT_BACKEND,
  }) as HTMLInputElement;
  const submit = h("button", { type: "submit" }, [
    "Connect with webtm.io",
  ]) as HTMLButtonElement;
  const error = h("div", { class: "error", role: "alert" }, [
    errorMessage ?? "",
  ]);
  const form = h("form", { class: "section connect-form" }, [
    h("p", { class: "connect-title" }, ["Connect this browser"]),
    h("p", { class: "connect-copy" }, [
      "Sign in once on webtm.io. Your password never enters the extension.",
    ]),
    h("div", { class: "field" }, [
      h("label", { for: "backend" }, ["Backend URL"]),
      backend,
    ]),
    submit,
    error,
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    submit.disabled = true;
    const baseUrl = backend.value.trim().replace(/\/+$/, "") || DEFAULT_BACKEND;
    try {
      const { verifier, challenge } = await createPkcePair();
      const response = await new WtmClient({ baseUrl }).startExtensionAuth({
        codeChallenge: challenge,
        client: extensionClientName(),
      });
      const pending: PendingConnection = {
        requestId: response.requestId,
        codeVerifier: verifier,
        expiresAt: response.expiresAt,
        baseUrl,
      };
      await mutate({ baseUrl, pendingConnection: pending });
      renderPending(pending);
      try {
        await chrome.tabs.create({ url: connectionUrl(pending) });
      } catch {
        renderPending(
          pending,
          "Couldn’t open a tab automatically. Use Open webtm.io below.",
        );
      }
    } catch (caught) {
      error.textContent =
        caught instanceof WtmApiError
          ? caught.message
          : `Could not reach ${baseUrl}`;
      submit.disabled = false;
    }
  });

  app.append(brandHeader(), form);
}

function renderPending(
  pending: PendingConnection,
  errorMessage?: string,
): void {
  app.replaceChildren();
  const check = h("button", { type: "button" }, [
    "Check connection",
  ]) as HTMLButtonElement;
  check.addEventListener("click", () => {
    check.disabled = true;
    void renderAuth();
  });
  const restart = h(
    "button",
    { type: "button", class: "secondary" },
    ["Start over"],
  ) as HTMLButtonElement;
  restart.addEventListener("click", async () => {
    restart.disabled = true;
    await mutate({ pendingConnection: null });
    await renderAuth();
  });

  app.append(
    brandHeader(),
    h("div", { class: "section connect-pending" }, [
      h("p", { class: "connect-title" }, ["Finish on webtm.io"]),
      h("p", { class: "connect-copy" }, [
        "Sign in and approve this browser. Then reopen this popup or check the connection here.",
      ]),
      h(
        "a",
        {
          class: "primary-action",
          href: connectionUrl(pending),
          target: "_blank",
          rel: "noreferrer",
        },
        ["Open webtm.io"],
      ),
      h("div", { class: "row connect-actions" }, [check, restart]),
      h("div", { class: "error", role: "alert" }, [errorMessage ?? ""]),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Connected view
// ---------------------------------------------------------------------------

async function renderStatus(container: HTMLElement): Promise<void> {
  const state = await getState();
  const queued = await getQueueCount();
  const children: (Node | string)[] = [
    h("span", {}, [h("b", {}, [String(queued)]), " queued"]),
    " · ",
    h("span", {}, [
      state.lastSync ? `synced ${timeAgo(state.lastSync)}` : "not synced yet",
    ]),
  ];
  const errorTtlMs = 15 * 60_000;
  if (
    state.lastError &&
    state.lastErrorAt &&
    Date.now() - state.lastErrorAt < errorTtlMs
  ) {
    const className = /storage was full/i.test(state.lastError)
      ? "hint"
      : "error";
    children.push(
      h("div", { class: className }, [
        `${state.lastError} (${timeAgo(state.lastErrorAt)})`,
      ]),
    );
  }
  container.replaceChildren(...children);
}

async function renderApp(): Promise<void> {
  const state = await getState();
  if (!state.token || !state.user) {
    await renderAuth();
    return;
  }

  app.replaceChildren();
  const captureToggle = h("input", {
    type: "checkbox",
  }) as HTMLInputElement;
  captureToggle.checked = state.captureEnabled;
  captureToggle.addEventListener("change", async () => {
    const wanted = captureToggle.checked;
    try {
      await mutate({ captureEnabled: wanted });
    } catch {
      captureToggle.checked = !wanted;
    }
  });

  const disconnect = h("button", { type: "button", class: "link" }, [
    "Disconnect",
  ]) as HTMLButtonElement;
  disconnect.addEventListener("click", async () => {
    disconnect.disabled = true;
    try {
      await (await client()).logout();
    } catch {
      // Local disconnect still works offline. The server token expires later.
    }
    try {
      await mutate({ token: null, user: null, pendingConnection: null });
      await renderAuth();
    } catch {
      disconnect.disabled = false;
      disconnect.textContent = "Disconnect failed — retry";
    }
  });

  app.append(
    h("header", {}, [
      h("span", { class: "brand", html: 'WTM<span class="dot">.</span>' }),
      h("span", { class: "email" }, [state.user.email]),
      h("span", { class: "spacer" }),
      h("label", { class: "toggle", title: "Capture pages" }, [
        captureToggle,
        "capture",
      ]),
      disconnect,
    ]),
  );

  const status = h("div", { class: "section status" });
  app.append(status);
  await renderStatus(status);

  void chrome.runtime
    .sendMessage({ type: "flushNow" })
    .catch(() => null)
    .then(() => renderStatus(status));

  app.append(
    h("div", { class: "section search-launcher" }, [
      h(
        "a",
        {
          class: "primary-action",
          href: DASHBOARD_URL,
          target: "_blank",
          rel: "noreferrer",
        },
        ["Search your history"],
      ),
      h("span", { class: "hint" }, ["Opens webtm.io"]),
    ]),
    buildDiagnostics(),
  );
}

function buildDiagnostics(): HTMLElement {
  const message = h("span", { class: "hint" });
  const clear = h(
    "button",
    { type: "button", class: "secondary tiny" },
    ["Clear stuck queue"],
  ) as HTMLButtonElement;
  clear.addEventListener("click", async () => {
    const queued = await getQueueCount();
    if (
      queued &&
      !confirm(
        `Discard ${queued} unsynced page(s) from this device? This can't be undone.`,
      )
    ) {
      return;
    }
    clear.disabled = true;
    message.textContent = "";
    try {
      const response = await sendBg({ type: "clearQueue" });
      if (!response?.ok) throw new Error(response?.error ?? "failed");
      message.textContent = "Queue cleared.";
    } catch {
      message.textContent = "Couldn't clear the queue.";
    } finally {
      clear.disabled = false;
    }
  });

  return h("details", { class: "section diagnostics" }, [
    h("summary", {}, ["Diagnostics"]),
    h("p", { class: "hint" }, [
      "Account settings and security controls live on webtm.io.",
    ]),
    h("div", { class: "row" }, [clear, message]),
  ]);
}

void renderApp();
