import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  AI: Ai;
  /** Token/client/grant storage for the MCP OAuth layer. */
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider on requests it routes to the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;

  /** HMAC secret for signing session JWTs (wrangler secret). */
  JWT_SECRET: string;
  /** Workers AI model id used for one-line summaries. */
  SUMMARY_MODEL: string;
  /** Default retention window applied to new users. */
  DEFAULT_RETENTION_DAYS: string;
}

/** Variables stored on the Hono context after auth. */
export interface Vars {
  userId: string;
  email: string;
}
