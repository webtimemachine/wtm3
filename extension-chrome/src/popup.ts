import { WtmApiError, WtmClient } from "@wtm/shared/api";
import {
  isValidRetentionDays,
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  type PageRecord,
  type SearchHit,
  type SearchOptions,
  type SearchSort,
} from "@wtm/shared";
import { chooseSubline, SEARCH_DEBOUNCE_MS, snippetHtml, timeAgo } from "@wtm/shared/format";
import {
  SEARCH_TIME_CHOICES,
  searchRangeForPreset,
  type SearchTimePreset,
} from "@wtm/shared/search";
import { DEFAULT_BACKEND, PLATFORM, type ExtState } from "./config";
import { getQueueCount, getState } from "./storage";

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
// The popup NEVER writes storage directly — the background worker is the
// single writer (that's what makes its storage mutex an actual mutex). Every
// mutation goes through a message; one retry covers Safari's occasional
// dropped first delivery; a failure is surfaced, never silently swallowed by
// falling back to a direct write (that would reintroduce the race this
// design exists to kill).
// ---------------------------------------------------------------------------

async function sendBg<T = { ok: boolean; error?: string; state?: ExtState }>(msg: unknown): Promise<T> {
  const attempt = () => chrome.runtime.sendMessage(msg) as Promise<T>;
  try {
    return await attempt();
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    return attempt();
  }
}

async function mutate(patch: Partial<ExtState>, opts: { thenFlush?: boolean } = {}): Promise<ExtState> {
  const resp = await sendBg<{ ok: boolean; error?: string; state?: ExtState }>({
    type: "setState",
    patch,
    thenFlush: opts.thenFlush,
  });
  if (!resp?.ok || !resp.state) throw new Error(resp?.error ?? "Couldn't save — try again.");
  return resp.state;
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
      const clientName =
        PLATFORM === "safari-ios"
          ? "Safari extension"
          : PLATFORM === "firefox-android"
            ? "Firefox extension"
            : "Chrome extension";
      const res = register
        ? await c.register({ email, password, client: clientName })
        : await c.login({ email, password, client: clientName });
      // deviceId/deviceOwner reconciliation happens in the background's flush
      // (it regenerates the node id when the account or backend changed).
      await mutate(
        { baseUrl, token: res.token, user: res.user, lastError: null, lastErrorAt: null },
        { thenFlush: true },
      );
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

async function renderStatus(container: HTMLElement): Promise<void> {
  const st = await getState();
  const queued = await getQueueCount(); // envelope carries the count — no decompress
  const children: (Node | string)[] = [
    h("span", {}, [h("b", {}, [String(queued)]), " queued"]),
    " · ",
    h("span", {}, [st.lastSync ? `synced ${timeAgo(st.lastSync)}` : "not synced yet"]),
  ];
  // Errors wear off: show only recent ones (with their age), styled as a muted
  // notice when it's a recovered storage-trim rather than a real failure.
  const ERROR_TTL_MS = 15 * 60_000;
  if (st.lastError && st.lastErrorAt && Date.now() - st.lastErrorAt < ERROR_TTL_MS) {
    const cls = /storage was full/i.test(st.lastError) ? "hint" : "error";
    children.push(h("div", { class: cls }, [`${st.lastError} (${timeAgo(st.lastErrorAt)})`]));
  }
  container.replaceChildren(...children);
}

async function renderApp(): Promise<void> {
  const st = await getState();
  if (!st.token || !st.user) return renderAuth();

  app.replaceChildren();

  // header
  const captureToggle = h("input", { type: "checkbox" }) as HTMLInputElement;
  captureToggle.checked = st.captureEnabled;
  captureToggle.addEventListener("change", async () => {
    const wanted = captureToggle.checked;
    try {
      await mutate({ captureEnabled: wanted });
    } catch {
      captureToggle.checked = !wanted; // optimistic UI, reverted on failure
    }
  });
  const logout = h("button", { class: "link" }, ["Log out"]);
  logout.addEventListener("click", async () => {
    try {
      await (await client()).logout();
    } catch {
      // Local logout still succeeds while offline; the server session expires
      // or can be revoked later with Log out everywhere.
    }
    try {
      // Keep deviceId + deviceOwner: logging back into the same account should
      // reuse this device's node instead of registering a duplicate.
      await mutate({ token: null, user: null });
      await renderAuth();
    } catch {
      logout.textContent = "Log out failed — retry";
    }
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
  const status = h("div", { class: "section status" });
  app.append(status);
  await renderStatus(status);

  // Nudge a flush attempt every time the popup opens. On iOS, background
  // execution can be suspended mid-drain (the extension only gets to run
  // while Safari is resident) and only resumes on the next trigger — a
  // capture or the 1-minute alarm, which can be delayed indefinitely if
  // Safari isn't foregrounded. Opening the popup is a reliable moment the
  // extension IS resident, so use it as an extra trigger. Fire-and-forget:
  // don't block the initial render, just refresh the status line if it
  // lands while the popup is still open.
  void chrome.runtime
    .sendMessage({ type: "flushNow" })
    .catch(() => null)
    .then(() => renderStatus(status));

  // settings (collapsible)
  app.append(await buildSettings(st));

  // search
  const search = h("input", { type: "search", placeholder: "Search your history…" }) as HTMLInputElement;
  const timeSelect = h("select", { "aria-label": "Time range" }) as HTMLSelectElement;
  for (const choice of SEARCH_TIME_CHOICES) {
    timeSelect.append(h("option", { value: choice.value }, [choice.label]));
  }
  const siteInput = h("input", {
    type: "search",
    placeholder: "Site, e.g. nytimes.com",
    "aria-label": "Site",
  }) as HTMLInputElement;
  const sortSelect = h("select", { "aria-label": "Sort" }) as HTMLSelectElement;
  for (const [value, label] of [
    ["relevance", "Relevance"],
    ["newest", "Newest first"],
    ["oldest", "Oldest first"],
  ] as const) {
    sortSelect.append(h("option", { value }, [label]));
  }
  const fromInput = h("input", { type: "date", "aria-label": "From date" }) as HTMLInputElement;
  const toInput = h("input", { type: "date", "aria-label": "Through date" }) as HTMLInputElement;
  const customDates = h("div", { class: "search-custom-dates" }, [
    h("label", {}, ["From", fromInput]),
    h("label", {}, ["Through", toInput]),
  ]);
  customDates.hidden = true;
  app.append(
    h("div", { class: "section search-section" }, [
      search,
      h("div", { class: "search-filter-grid" }, [
        h("label", {}, ["When", timeSelect]),
        h("label", {}, ["Sort", sortSelect]),
        h("label", { class: "search-site" }, ["Site", siteInput]),
      ]),
      customDates,
    ]),
  );

  const results = h("div", { class: "results" }, [h("div", { class: "empty" }, ["Loading recent pages…"])]);
  app.append(results);

  const currentSearchOptions = (): SearchOptions => ({
    limit: 30,
    ...searchRangeForPreset(
      timeSelect.value as SearchTimePreset,
      fromInput.value,
      toInput.value,
    ),
    site: siteInput.value.trim(),
    sort: sortSelect.value as SearchSort,
  });
  const scheduleSearch = () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(
      () => void runSearch(search.value.trim(), results, currentSearchOptions()),
      SEARCH_DEBOUNCE_MS,
    );
  };
  search.addEventListener("input", scheduleSearch);
  siteInput.addEventListener("input", scheduleSearch);
  sortSelect.addEventListener("change", scheduleSearch);
  timeSelect.addEventListener("change", () => {
    customDates.hidden = timeSelect.value !== "custom";
    scheduleSearch();
  });
  fromInput.addEventListener("change", scheduleSearch);
  toInput.addEventListener("change", scheduleSearch);

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
      await mutate({ user: u });
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
      await mutate({ user: u });
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

  const queueMsg = h("span", { class: "hint" }, []);
  const clearBtn = h("button", { class: "secondary tiny" }, ["Clear stuck queue"]) as HTMLButtonElement;

  clearBtn.addEventListener("click", async () => {
    const queued = await getQueueCount();
    if (queued && !confirm(`Discard ${queued} unsynced page(s) from this device? This can't be undone.`)) {
      return;
    }
    clearBtn.disabled = true;
    queueMsg.textContent = "";
    try {
      const resp = await sendBg({ type: "clearQueue" });
      if (!resp?.ok) throw new Error(resp?.error ?? "failed");
      queueMsg.textContent = "Queue cleared.";
    } catch {
      queueMsg.textContent = "Couldn't clear the queue.";
    } finally {
      clearBtn.disabled = false;
    }
  });

  children.push(
    h("div", { class: "field" }, [
      h("label", {}, ["Sync stuck?"]),
      h("div", { class: "row" }, [clearBtn, queueMsg]),
    ]),
  );

  const everywhereBtn = h("button", { class: "secondary tiny" }, [
    "Log out everywhere",
  ]) as HTMLButtonElement;
  const everywhereMsg = h("span", { class: "hint" }, []);
  everywhereBtn.addEventListener("click", async () => {
    if (!confirm("Log out every Web Time Machine session and connected AI client?")) return;
    everywhereBtn.disabled = true;
    everywhereMsg.textContent = "";
    try {
      await (await client()).logoutEverywhere();
      await mutate({ token: null, user: null });
      await renderAuth();
    } catch (e) {
      everywhereMsg.textContent =
        e instanceof WtmApiError ? e.message : "Could not log out everywhere.";
      everywhereBtn.disabled = false;
    }
  });
  children.push(
    h("div", { class: "field" }, [
      h("label", {}, ["Account security"]),
      h("div", { class: "row" }, [everywhereBtn, everywhereMsg]),
    ]),
  );

  return h("details", { class: "section settings" }, children);
}

function renderHit(p: PageRecord | SearchHit): HTMLElement {
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

async function requireRelogin(error: unknown): Promise<boolean> {
  if (!(error instanceof WtmApiError) || error.status !== 401) return false;
  await mutate({ token: null, user: null });
  await renderAuth("Your session ended. Log in once to continue.");
  return true;
}

async function loadRecent(results: HTMLElement): Promise<void> {
  try {
    const { pages } = await (await client()).recent({ limit: 30 });
    results.replaceChildren();
    if (!pages.length) {
      results.append(h("div", { class: "empty" }, ["No pages captured yet. Browse a few sites!"]));
      return;
    }
    for (const p of pages) results.append(renderHit(p));
  } catch (e) {
    if (await requireRelogin(e)) return;
    results.replaceChildren(
      h("div", { class: "empty error" }, [e instanceof WtmApiError ? e.message : "Failed to load."]),
    );
  }
}

async function runSearch(
  q: string,
  results: HTMLElement,
  options: SearchOptions,
): Promise<void> {
  if (!q) return loadRecent(results);
  if (
    options.from !== undefined &&
    options.to !== undefined &&
    options.from >= options.to
  ) {
    results.replaceChildren(
      h("div", { class: "empty error" }, ["The start date must be before the end date."]),
    );
    return;
  }
  try {
    const res = await (await client()).search(q, options);
    results.replaceChildren();
    if (!res.hits.length) {
      results.append(h("div", { class: "empty" }, [`No matches for “${q}”.`]));
      return;
    }
    for (const hit of res.hits) results.append(renderHit(hit));
  } catch (e) {
    if (await requireRelogin(e)) return;
    results.replaceChildren(
      h("div", { class: "empty error" }, [e instanceof WtmApiError ? e.message : "Search failed."]),
    );
  }
}

void renderApp();
