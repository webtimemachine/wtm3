import { WtmApiError, WtmClient } from "@wtm/shared/api";
import { isValidRetentionDays, RETENTION_MAX_DAYS, RETENTION_MIN_DAYS, type PageRecord, type SearchHit } from "@wtm/shared";
import { chooseSubline, snippetHtml, timeAgo } from "@wtm/shared/format";
import { DEFAULT_BACKEND, deviceOwnerKey } from "./config";
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
      // Re-login into the same account on the same backend keeps this device's
      // node registration; anything else starts fresh (no duplicate nodes).
      const prev = await getState();
      const owner = deviceOwnerKey(baseUrl, res.user.id);
      const deviceId = prev.deviceOwner === owner ? prev.deviceId : null;
      await setState({ baseUrl, token: res.token, user: res.user, deviceId, deviceOwner: owner, lastError: null });
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
    // Keep deviceId + deviceOwner: logging back into the same account should
    // reuse this device's node instead of registering a duplicate.
    await setState({ token: null, user: null });
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
  // Errors wear off: show only recent ones (with their age), styled as a muted
  // notice when it's a recovered storage-trim rather than a real failure.
  const ERROR_TTL_MS = 15 * 60_000;
  if (st.lastError && st.lastErrorAt && Date.now() - st.lastErrorAt < ERROR_TTL_MS) {
    const cls = /storage was full/i.test(st.lastError) ? "hint" : "error";
    status.append(h("div", { class: cls }, [`${st.lastError} (${timeAgo(st.lastErrorAt)})`]));
  }
  app.append(status);

  // settings (collapsible)
  app.append(await buildSettings(st));

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

async function buildSettings(st: Awaited<ReturnType<typeof getState>>): Promise<HTMLElement> {
  // Sensitive filter
  const filterCb = h("input", { type: "checkbox" }) as HTMLInputElement;
  filterCb.checked = !!st.user?.filterSensitive;
  filterCb.addEventListener("change", async () => {
    filterCb.disabled = true;
    try {
      const u = await (await client()).updateSettings({ filterSensitive: filterCb.checked });
      await setState({ user: u });
    } catch {
      filterCb.checked = !filterCb.checked;
    } finally {
      filterCb.disabled = false;
    }
  });

  // History expiration
  const daysInput = h("input", {
    type: "number",
    min: String(RETENTION_MIN_DAYS),
    max: String(RETENTION_MAX_DAYS),
    value: String(st.user?.retentionDays ?? 90),
  }) as HTMLInputElement;
  const daysBtn = h("button", { class: "secondary tiny" }, ["Save"]) as HTMLButtonElement;
  const daysMsg = h("span", { class: "hint" }, []);
  daysBtn.addEventListener("click", async () => {
    const d = parseInt(daysInput.value, 10);
    if (!isValidRetentionDays(d)) {
      daysMsg.textContent = `${RETENTION_MIN_DAYS}–${RETENTION_MAX_DAYS} days`;
      return;
    }
    daysBtn.disabled = true;
    daysMsg.textContent = "";
    try {
      const u = await (await client()).updateSettings({ retentionDays: d });
      await setState({ user: u });
      daysMsg.textContent = "Saved";
    } catch (e) {
      daysMsg.textContent = e instanceof WtmApiError ? e.message : "Failed";
    } finally {
      daysBtn.disabled = false;
    }
  });

  const children: (Node | string)[] = [
    h("summary", {}, ["Settings"]),
    h("label", { class: "toggle" }, [filterCb, "Hide sensitive pages"]),
    h("div", { class: "field" }, [
      h("label", {}, ["History expiration (days)"]),
      h("div", { class: "row" }, [daysInput, daysBtn, daysMsg]),
    ]),
  ];

  // Rename this device (once it has registered a node id)
  if (st.deviceId) {
    const did = st.deviceId;
    let current = "";
    try {
      const { nodes } = await (await client()).listNodes();
      current = nodes.find((n) => n.id === did)?.name ?? "";
    } catch {
      /* ignore — leave blank */
    }
    const nameInput = h("input", {
      type: "text",
      placeholder: "This device's name",
      value: current,
    }) as HTMLInputElement;
    const nameBtn = h("button", { class: "secondary tiny" }, ["Rename"]) as HTMLButtonElement;
    const nameMsg = h("span", { class: "hint" }, []);
    nameBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      nameBtn.disabled = true;
      nameMsg.textContent = "";
      try {
        await (await client()).renameNode(did, name);
        nameMsg.textContent = "Renamed";
      } catch (e) {
        nameMsg.textContent = e instanceof WtmApiError ? e.message : "Failed";
      } finally {
        nameBtn.disabled = false;
      }
    });
    children.push(
      h("div", { class: "field" }, [
        h("label", {}, ["This device"]),
        h("div", { class: "row" }, [nameInput, nameBtn, nameMsg]),
      ]),
    );
  }

  return h("details", { class: "section settings" }, children);
}

function renderHit(p: PageRecord | SearchHit, results: HTMLElement): HTMLElement {
  // Shared snippet→summary→pending precedence (same decision as the web app).
  const chosen = chooseSubline({ ...(("snippet" in p) && { snippet: p.snippet }), summary: p.summary, summaryStatus: p.summaryStatus });
  const sub =
    chosen.kind === "snippet"
      ? h("div", { class: "snippet", html: snippetHtml(chosen.value) })
      : chosen.kind === "summary"
        ? h("div", { class: "summary" }, [chosen.value])
        : chosen.kind === "pending"
          ? h("div", { class: "summary hint" }, ["Summarizing…"])
          : null;

  const del = h("button", { class: "secondary tiny", title: "Delete everywhere" }, ["Delete"]) as HTMLButtonElement;
  del.addEventListener("click", async () => {
    del.disabled = true;
    try {
      await (await client()).deletePage(p.id);
      row.remove();
    } catch {
      del.disabled = false;
    }
  });

  const children: (Node | string)[] = [
    h("a", { class: "title", href: p.url, target: "_blank", rel: "noreferrer" }, [p.title || p.url]),
  ];
  if (sub) children.push(sub);
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
