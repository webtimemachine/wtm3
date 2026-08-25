import { WtmApiError, WtmClient } from "@wtm/shared/api";
import { createPkcePair } from "@wtm/shared/auth";
import { timeAgo } from "@wtm/shared/format";
import { DEFAULT_BACKEND, PLATFORM, type ExtState } from "./config";
import { getQueueCount, getState } from "./storage";

const app = document.getElementById("app") as HTMLDivElement;
const DASHBOARD_URL = "https://webtm.io/";
const SEARCH_URL = "https://webtm.io/search";
const NATIVE_APP_ID = "com.ttt246llc.wtm";

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

async function notifyNative(
  message: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (PLATFORM !== "safari-ios") return null;
  try {
    return (await chrome.runtime.sendNativeMessage(
      NATIVE_APP_ID,
      message,
    )) as Record<string, unknown>;
  } catch {
    // The containing app may not have launched yet. The extension state still
    // keeps the feature usable; reopening the popup retries configuration.
    return null;
  }
}

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
      if (response.scope !== "capture") {
        throw new Error("The server returned the wrong extension permission.");
      }
      await mutate(
        {
          baseUrl: state.pendingConnection.baseUrl,
          token: response.token,
          tokenScope: "capture",
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
        scope: "capture",
      });
      const pending: PendingConnection = {
        requestId: response.requestId,
        codeVerifier: verifier,
        expiresAt: response.expiresAt,
        baseUrl,
        scope: "capture",
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
  let state = await getState();
  if (state.token && state.user && state.tokenScope !== "capture") {
    await mutate({ token: null, tokenScope: null, user: null });
    await renderAuth();
    return;
  }
  if (!state.token || !state.user) {
    await renderAuth();
    return;
  }

  state = await pollAssistConnection(state);
  if (!state.user) {
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
    if (state.assistToken) {
      try {
        await new WtmClient({ baseUrl: state.baseUrl, token: state.assistToken }).logout();
      } catch {
        // Local disconnect remains available offline.
      }
    }
    await notifyNative({ type: "disableSearchAssist" });
    try {
      await mutate({
        token: null,
        tokenScope: null,
        assistToken: null,
        assistEnabled: false,
        lastAssistError: null,
        user: null,
        pendingConnection: null,
        pendingAssistConnection: null,
      });
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
    PLATFORM === "firefox-android"
      ? h("div", { class: "section search-launcher" }, [
          h("a", {
            class: "primary-action",
            href: DASHBOARD_URL,
            target: "_blank",
            rel: "noreferrer",
          }, ["Search your history"]),
          h("span", { class: "hint" }, ["Opens webtm.io"]),
        ])
      : buildSearchAssist(state),
    buildDiagnostics(),
  );
}

async function pollAssistConnection(state: ExtState): Promise<ExtState> {
  const pending = state.pendingAssistConnection;
  if (!pending) {
    if (state.assistEnabled && state.assistToken) {
      const native = await notifyNative({
        type: "configureSearchAssist",
        token: state.assistToken,
        baseUrl: state.baseUrl,
        force: false,
      });
      if (native?.error === "disabled_in_app") {
        try {
          await new WtmClient({ baseUrl: state.baseUrl, token: state.assistToken }).logout();
        } catch {
          // Clear locally even if revocation is offline.
        }
        return mutate({
          assistToken: null,
          assistEnabled: false,
          searchRouterEnabled: false,
          lastAssistError: "Search Assist was disabled from the iOS app.",
        });
      }
    }
    return state;
  }
  if (pending.expiresAt <= Date.now()) {
    return mutate({ pendingAssistConnection: null });
  }
  try {
    const response = await new WtmClient({ baseUrl: pending.baseUrl })
      .exchangeExtensionAuth({
        requestId: pending.requestId,
        codeVerifier: pending.codeVerifier,
      });
    if (response.status !== "connected") return state;
    if (response.scope !== "assist") {
      return mutate({
        pendingAssistConnection: null,
        lastAssistError: "The server returned the wrong Search Assist permission.",
      });
    }
    if (!state.user || response.user.id !== state.user.id) {
      try {
        await new WtmClient({ baseUrl: pending.baseUrl, token: response.token }).logout();
      } catch {
        // The rejected grant will expire even if immediate revocation is offline.
      }
      return mutate({
        pendingAssistConnection: null,
        lastAssistError: "Search Assist was approved for a different account. Sign in to the same account on webtm.io and try again.",
      });
    }
    const next = await mutate({
      assistToken: response.token,
      assistEnabled: true,
      pendingAssistConnection: null,
      lastAssistError: null,
    });
    await notifyNative({
      type: "configureSearchAssist",
      token: response.token,
      baseUrl: pending.baseUrl,
      force: true,
    });
    return next;
  } catch (caught) {
    if (caught instanceof WtmApiError && (caught.status === 404 || caught.status === 410)) {
      return mutate({ pendingAssistConnection: null });
    }
    return state;
  }
}

function buildSearchAssist(state: ExtState): HTMLElement {
  const section = h("div", { class: "section search-assist" });
  section.append(
    h("div", { class: "row section-heading" }, [
      h("b", {}, ["Search Assist"]),
      h("span", { class: `assist-state ${state.assistEnabled ? "on" : ""}` }, [
        state.assistEnabled ? "On" : "Off",
      ]),
    ]),
  );

  const pending = state.pendingAssistConnection;
  if (pending) {
    const check = h("button", { type: "button" }, ["Check approval"]) as HTMLButtonElement;
    check.addEventListener("click", () => {
      check.disabled = true;
      void renderApp();
    });
    const cancel = h("button", { type: "button", class: "secondary" }, ["Cancel"]) as HTMLButtonElement;
    cancel.addEventListener("click", async () => {
      await mutate({ pendingAssistConnection: null });
      await renderApp();
    });
    section.append(
      h("p", { class: "hint" }, ["Approve read-only history suggestions on webtm.io."]),
      h("a", { class: "primary-action", href: connectionUrl(pending), target: "_blank", rel: "noreferrer" }, ["Open approval"]),
      h("div", { class: "row" }, [check, cancel]),
    );
    return section;
  }

  if (!state.assistEnabled || !state.assistToken) {
    const enable = h("button", { type: "button" }, ["Enable Search Assist"]) as HTMLButtonElement;
    const message = h("div", { class: "error", role: "alert" });
    enable.addEventListener("click", async () => {
      enable.disabled = true;
      message.textContent = "";
      try {
        const { verifier, challenge } = await createPkcePair();
        const response = await new WtmClient({ baseUrl: state.baseUrl }).startExtensionAuth({
          codeChallenge: challenge,
          client: extensionClientName(),
          scope: "assist",
        });
        const next = {
          requestId: response.requestId,
          codeVerifier: verifier,
          expiresAt: response.expiresAt,
          baseUrl: state.baseUrl,
          scope: "assist" as const,
        };
        await mutate({ pendingAssistConnection: next, lastAssistError: null });
        await chrome.tabs.create({ url: connectionUrl(next) });
        await renderApp();
      } catch (caught) {
        message.textContent = caught instanceof WtmApiError ? caught.message : "Could not start Search Assist approval.";
        enable.disabled = false;
      }
    });
    section.append(
      h("p", { class: "hint" }, [
        PLATFORM === "safari-ios"
          ? "Find saved pages in this popup and iOS Spotlight. Safari controls address-bar ranking."
          : "Type wtm and a space in Chrome’s address bar to search your history.",
      ]),
      enable,
      message,
      state.lastAssistError
        ? h("div", { class: "error", role: "alert" }, [state.lastAssistError])
        : "",
    );
    return section;
  }

  const search = h("input", {
    type: "search",
    placeholder: "Search saved pages…",
    autocomplete: "off",
  }) as HTMLInputElement;
  const results = h("div", { class: "assist-results" });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  search.addEventListener("input", () => {
    if (timer) clearTimeout(timer);
    const query = search.value.trim();
    const current = ++generation;
    if (query.length < 2) {
      results.replaceChildren();
      return;
    }
    timer = setTimeout(async () => {
      try {
        const response = await new WtmClient({ baseUrl: state.baseUrl, token: state.assistToken }).suggest(query, 6);
        if (current !== generation) return;
        results.replaceChildren(
          ...response.suggestions.map((item) =>
            h("a", { class: "assist-result", href: item.url, target: "_blank", rel: "noreferrer" }, [
              h("span", { class: "assist-title" }, [item.title || item.url]),
              h("span", { class: "hint" }, [new URL(item.url).hostname]),
            ]),
          ),
        );
      } catch {
        if (current === generation) results.replaceChildren(h("span", { class: "error" }, ["Search unavailable."]));
      }
    }, 140);
  });

  const openFull = h("a", {
    class: "secondary-action",
    href: SEARCH_URL,
    target: "_blank",
    rel: "noreferrer",
  }, ["Full history search"]);
  const disable = h("button", { type: "button", class: "link danger" }, ["Disable"]) as HTMLButtonElement;
  disable.addEventListener("click", async () => {
    disable.disabled = true;
    try {
      await new WtmClient({ baseUrl: state.baseUrl, token: state.assistToken }).logout();
    } catch {
      // Always permit local disable.
    }
    await notifyNative({ type: "disableSearchAssist" });
    await mutate({
      assistToken: null,
      assistEnabled: false,
      lastAssistError: null,
      pendingAssistConnection: null,
      searchRouterEnabled: false,
    });
    await renderApp();
  });

  section.append(search, results, h("div", { class: "row assist-actions" }, [openFull, disable]));

  if (PLATFORM === "safari-ios") {
    const router = h("input", { type: "checkbox" }) as HTMLInputElement;
    router.checked = state.searchRouterEnabled;
    router.addEventListener("change", async () => {
      const wanted = router.checked;
      try {
        await mutate({ searchRouterEnabled: wanted });
      } catch {
        router.checked = !wanted;
      }
    });
    section.append(
      h("label", { class: "router-toggle" }, [router, h("span", {}, [
        "Route explicit ", h("code", {}, ["wtm "]), " or ", h("code", {}, ["!w "]), " searches",
      ])]),
      h("p", { class: "hint" }, ["Ordinary Safari searches and autocomplete stay unchanged."]),
    );
  }
  return section;
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
