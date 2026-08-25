// Typed client for the Web Time Machine backend. Environment-agnostic (uses
// global fetch) so the Chrome extension, the iOS Safari extension, and the web
// dashboard all talk to the backend through the same code path.

import {
  Routes,
  type AccountDeleteRequest,
  type AuthResponse,
  type ExtensionAuthExchangeRequest,
  type ExtensionAuthExchangeResponse,
  type ExtensionAuthRequestInfo,
  type ExtensionAuthStartRequest,
  type ExtensionAuthStartResponse,
  type ApiError,
  type LoginRequest,
  type NodeInfo,
  type PasswordChangeRequest,
  type PasswordResetConfirmRequest,
  type RecentResponse,
  type RegisterNodeRequest,
  type RegisterRequest,
  type SearchResponse,
  type SearchOptions,
  type SuggestResponse,
  type IndexSnapshotResponse,
  type SettingsUpdate,
  type SyncPushRequest,
  type SyncPushResponse,
  type UserInfo,
} from "./index";

export class WtmApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "WtmApiError";
  }
}

export interface WtmClientOptions {
  baseUrl: string;
  token?: string | null;
  fetchImpl?: typeof fetch;
}

export class WtmClient {
  private baseUrl: string;
  private token: string | null;
  private f: typeof fetch;

  constructor(opts: WtmClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token ?? null;
    this.f = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await this.f(`${this.baseUrl}${path}`, {
      method,
      headers,
      signal,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      let err: ApiError = { error: "http_error", message: `HTTP ${res.status}` };
      try {
        err = (await res.json()) as ApiError;
      } catch {
        /* non-JSON error body */
      }
      throw new WtmApiError(res.status, err.error ?? "http_error", err.message ?? `HTTP ${res.status}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // --- auth ---
  register(req: RegisterRequest): Promise<AuthResponse> {
    return this.req("POST", Routes.register, req);
  }
  login(req: LoginRequest): Promise<AuthResponse> {
    return this.req("POST", Routes.login, req);
  }
  async logout(): Promise<void> {
    await this.req("POST", Routes.logout);
  }
  async logoutEverywhere(): Promise<void> {
    await this.req("POST", Routes.logoutEverywhere);
  }
  changePassword(req: PasswordChangeRequest): Promise<AuthResponse> {
    return this.req("POST", Routes.changePassword, req);
  }
  async requestPasswordReset(email: string): Promise<void> {
    await this.req("POST", Routes.requestPasswordReset, { email });
  }
  async confirmPasswordReset(req: PasswordResetConfirmRequest): Promise<void> {
    await this.req("POST", Routes.confirmPasswordReset, req);
  }
  startExtensionAuth(req: ExtensionAuthStartRequest): Promise<ExtensionAuthStartResponse> {
    return this.req("POST", Routes.extensionAuthStart, req);
  }
  extensionAuthRequest(requestId: string): Promise<ExtensionAuthRequestInfo> {
    return this.req("POST", Routes.extensionAuthRequest, { requestId });
  }
  async approveExtensionAuth(requestId: string): Promise<void> {
    await this.req("POST", Routes.extensionAuthApprove, { requestId });
  }
  exchangeExtensionAuth(req: ExtensionAuthExchangeRequest): Promise<ExtensionAuthExchangeResponse> {
    return this.req("POST", Routes.extensionAuthToken, req);
  }
  async deleteAccount(req: AccountDeleteRequest): Promise<void> {
    await this.req("DELETE", Routes.account, req);
  }
  me(): Promise<UserInfo> {
    return this.req("GET", Routes.me);
  }
  updateSettings(body: SettingsUpdate): Promise<UserInfo> {
    return this.req("PATCH", Routes.settings, body);
  }

  // --- nodes ---
  registerNode(req: RegisterNodeRequest): Promise<NodeInfo> {
    return this.req("POST", Routes.nodes, req);
  }
  listNodes(): Promise<{ nodes: NodeInfo[] }> {
    return this.req("GET", Routes.nodes);
  }
  renameNode(id: string, name: string): Promise<NodeInfo> {
    return this.req("PATCH", Routes.node(id), { name });
  }

  // --- sync ---
  push(req: SyncPushRequest): Promise<SyncPushResponse> {
    return this.req("POST", Routes.syncPush, req);
  }

  // --- search & pages ---
  search(query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
    const p = new URLSearchParams({ q: query });
    if (opts.limit != null) p.set("limit", String(opts.limit));
    if (opts.offset != null) p.set("offset", String(opts.offset));
    if (opts.from != null) p.set("from", String(opts.from));
    if (opts.to != null) p.set("to", String(opts.to));
    if (opts.site?.trim()) p.set("site", opts.site.trim());
    if (opts.sort) p.set("sort", opts.sort);
    return this.req("GET", `${Routes.search}?${p.toString()}`);
  }
  suggest(query: string, limit = 6, signal?: AbortSignal): Promise<SuggestResponse> {
    const p = new URLSearchParams({ q: query, limit: String(limit) });
    return this.req("GET", `${Routes.suggest}?${p.toString()}`, undefined, signal);
  }
  indexSnapshot(limit = 2000): Promise<IndexSnapshotResponse> {
    const p = new URLSearchParams({ limit: String(limit) });
    return this.req("GET", `${Routes.indexSnapshot}?${p.toString()}`);
  }
  recent(opts: { limit?: number; before?: number } = {}): Promise<RecentResponse> {
    const p = new URLSearchParams();
    if (opts.limit != null) p.set("limit", String(opts.limit));
    if (opts.before != null) p.set("before", String(opts.before));
    const qs = p.toString();
    return this.req("GET", qs ? `${Routes.recent}?${qs}` : Routes.recent);
  }
  async getText(id: string): Promise<string> {
    const headers: Record<string, string> = {};
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    const res = await this.f(`${this.baseUrl}${Routes.pageText(id)}`, { headers });
    if (!res.ok) throw new WtmApiError(res.status, "http_error", `HTTP ${res.status}`);
    return res.text();
  }
  async deletePage(id: string): Promise<void> {
    await this.req("DELETE", Routes.page(id));
  }
}
