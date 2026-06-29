// Typed client for the Web Time Machine backend. Environment-agnostic (uses
// global fetch) so the Chrome extension, the iOS Safari extension, and the web
// dashboard all talk to the backend through the same code path.

import {
  Routes,
  type AuthResponse,
  type ApiError,
  type LoginRequest,
  type NodeInfo,
  type PageRecord,
  type RecentResponse,
  type RegisterNodeRequest,
  type RegisterRequest,
  type SearchResponse,
  type SyncPullResponse,
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

  setToken(token: string | null): void {
    this.token = token;
  }

  get hasToken(): boolean {
    return !!this.token;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await this.f(`${this.baseUrl}${path}`, {
      method,
      headers,
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
  me(): Promise<UserInfo> {
    return this.req("GET", Routes.me);
  }

  // --- nodes ---
  registerNode(req: RegisterNodeRequest): Promise<NodeInfo> {
    return this.req("POST", Routes.nodes, req);
  }
  listNodes(): Promise<{ nodes: NodeInfo[] }> {
    return this.req("GET", Routes.nodes);
  }

  // --- sync ---
  push(req: SyncPushRequest): Promise<SyncPushResponse> {
    return this.req("POST", Routes.syncPush, req);
  }
  pull(since: number, limit = 500): Promise<SyncPullResponse> {
    return this.req("GET", `${Routes.syncPull}?since=${since}&limit=${limit}`);
  }

  // --- search & pages ---
  search(query: string, opts: { limit?: number; offset?: number } = {}): Promise<SearchResponse> {
    const p = new URLSearchParams({ q: query });
    if (opts.limit != null) p.set("limit", String(opts.limit));
    if (opts.offset != null) p.set("offset", String(opts.offset));
    return this.req("GET", `${Routes.search}?${p.toString()}`);
  }
  recent(opts: { limit?: number; before?: number } = {}): Promise<RecentResponse> {
    const p = new URLSearchParams();
    if (opts.limit != null) p.set("limit", String(opts.limit));
    if (opts.before != null) p.set("before", String(opts.before));
    const qs = p.toString();
    return this.req("GET", qs ? `${Routes.recent}?${qs}` : Routes.recent);
  }
  getPage(id: string): Promise<PageRecord> {
    return this.req("GET", Routes.page(id));
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
