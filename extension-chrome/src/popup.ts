import { WtmApiError, WtmClient } from "@wtm/shared/api";
import type { PageRecord, SearchHit } from "@wtm/shared";
import { DEFAULT_BACKEND } from "./config";
import { getQueue, getState, setState } from "./storage";

const app = document.getElementById("app") as HTMLDivElement;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<Record<string, string>> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

async function client(): Promise<WtmClient> {
  const st = await getState();
  return new WtmClient({ baseUrl: st.baseUrl, token: st.token });
}

// ---------------------------------------------------------------------------
// Logged-out view
// ---------------------------------------------------------------------------

async function renderAuth(errorMsg?: string): Promise<void> {
  const st = await getState();
  app.replaceChildren();

  app.append(
    h("header", {}, [h("span", { class: "brand", html: 'Web Time <span class="dot">Machine</span>' })]),
  );

  const urlField = h("input", { type: "text", id: "url", value: st.baseUrl || DEFAULT_BACKEND });
  const emailField = h("input", { type: "email", id: "email", placeholder: "you@example.com" });
  const passField = h("input", { type: "password", id: "pass", placeholder: "password (8+ chars)" });
  const err = h("div", { class: "error" }, [errorMsg ?? ""]);

  const loginBtn = h("button", {}, ["Log in"]) as HTMLButtonElement;
  const registerBtn = h("button", { class: "secondary" }, ["Create account"]) as HTMLButtonElement;

  async function submit(register: boolean): Promise<void> {
    err.textContent = "";
    const baseUrl = urlField.value.trim() || DEFAULT_BACKEND;
    const email = emailField.value.trim();
    const password = passField.value;
    if (!email || !password) {
      err.textContent = "Email and password required.";
      return;
    }
    loginBtn.disabled = registerBtn.disabled = true;
    try {
      const c = new WtmClient({ baseUrl });
      const res = register ? await c.register({ email, password }) : await c.login({ email, password });
      await setState({ baseUrl, token: res.token, user: res.user, deviceId: null, lastError: null });
      chrome.runtime.sendMessage({ type: "authChanged" });
      await renderApp();
    } catch (e) {
      err.textContent = e instanceof WtmApiError ? e.message : `Could not reach ${baseUrl}`;
      loginBtn.disabled = registerBtn.disabled = false;
    }
  }
  loginBtn.addEventListener("click", () => void submit(false));
  registerBtn.addEventListener("click", () => void submit(true));
  passField.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void submit(false);
  });

  app.append(
    h("div", { class: "section" }, [
      h("div", { class: "field" }, [h("label", {}, ["Backend URL"]), urlField]),
      h("div", { class: "field" }, [h("label", {}, ["Email"]), emailField]),
      h("div", { class: "field" }, [h("label", {}, ["Password"]), passField]),
      h("div", { class: "row" }, [loginBtn, registerBtn]),
      err,
    ]),
  );
}

// ---------------------------------------------------------------------------
// Logged-in view
// ---------------------------------------------------------------------------

let searchTimer: ReturnType<typeof setTimeout> | null = null;

async function renderApp(): Promise<void> {
  const st = await getState();
  if (!st.token || !st.user) return renderAuth();

  app.replaceChildren();

  // header
  const captureToggle = h("input", { type: "checkbox" }) as HTMLInputElement;
  captureToggle.checked = st.captureEnabled;
  captureToggle.addEventListener("change", () => void setState({ captureEnabled: captureToggle.checked }));
  const logout = h("button", { class: "link" }, ["Log out"]);
  logout.addEventListener("click", async () => {
    await setState({ token: null, user: null, deviceId: null });
    await renderAuth();
  });

  app.append(
    h("header", {}, [
      h("span", { class: "brand", html: 'WTM<span class="dot">.</span>' }),
      h("span", { class: "email" }, [st.user.email]),
      h("span", { class: "spacer" }),
      h("label", { class: "toggle", title: "Capture pages" }, [captureToggle, "capture"]),
      logout,
    ]),
  );

  // status
  const queue = await getQueue();
  const status = h("div", { class: "section status" }, [
    h("span", {}, [h("b", {}, [String(queue.length)]), " queued"]),
    " · ",
    h("span", {}, [st.lastSync ? `synced ${timeAgo(st.lastSync)}` : "not synced yet"]),
  ]);
  if (st.lastError) status.append(h("div", { class: "error" }, [st.lastError]));
  app.append(status);

  // search
  const search = h("input", { type: "search", placeholder: "Search your history…" }) as HTMLInputElement;
  app.append(h("div", { class: "section" }, [search]));

  const results = h("div", { class: "results" }, [h("div", { class: "empty" }, ["Loading recent pages…"])]);
  app.append(results);

  search.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void runSearch(search.value.trim(), results), 220);
  });

  await loadRecent(results);
}

function renderHit(p: PageRecord | SearchHit, results: HTMLElement): HTMLElement {
  const snippet = "snippet" in p && p.snippet ? h("div", { class: "snippet", html: p.snippet }) : null;
  const summary =
    p.summary && (!("snippet" in p) || !p.snippet) ? h("div", { class: "summary" }, [p.summary]) : null;

  const del = h("button", { class: "secondary tiny", title: "Delete everywhere" }, ["Delete"]) as HTMLButtonElement;
  del.addEventListener("click", async () => {
    del.disabled = true;
    try {
      (await client()).deletePage(p.id);
      row.remove();
    } catch {
      del.disabled = false;
    }
  });

  const children: (Node | string)[] = [
    h("a", { class: "title", href: p.url, target: "_blank", rel: "noreferrer" }, [p.title || p.url]),
  ];
  if (summary) children.push(summary);
  if (snippet) children.push(snippet);
  children.push(
    h("div", { class: "meta" }, [
      h("span", { class: "url" }, [p.url]),
      h("span", { class: "pill" }, [timeAgo(p.visitedAt)]),
      del,
    ]),
  );
  const row = h("div", { class: "hit" }, children);
  return row;
}

async function loadRecent(results: HTMLElement): Promise<void> {
  try {
    const { pages } = await (await client()).recent({ limit: 30 });
    results.replaceChildren();
    if (!pages.length) {
      results.append(h("div", { class: "empty" }, ["No pages captured yet. Browse a few sites!"]));
      return;
    }
    for (const p of pages) results.append(renderHit(p, results));
  } catch (e) {
    results.replaceChildren(
      h("div", { class: "empty error" }, [e instanceof WtmApiError ? e.message : "Failed to load."]),
    );
  }
}

async function runSearch(q: string, results: HTMLElement): Promise<void> {
  if (!q) return loadRecent(results);
  try {
    const res = await (await client()).search(q, { limit: 30 });
    results.replaceChildren();
    if (!res.hits.length) {
      results.append(h("div", { class: "empty" }, [`No matches for “${q}”.`]));
      return;
    }
    for (const hit of res.hits) results.append(renderHit(hit, results));
  } catch (e) {
    results.replaceChildren(
      h("div", { class: "empty error" }, [e instanceof WtmApiError ? e.message : "Search failed."]),
    );
  }
}

void renderApp();
