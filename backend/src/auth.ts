// Cloudflare Workers' WebCrypto caps PBKDF2 at 100,000 iterations.
const PBKDF2_ITERATIONS = 100_000;
const KEY_BITS = 256;
const SALT_BYTES = 16;
const SESSION_BYTES = 32;
const SESSION_TTL_MS = 90 * 86_400_000;
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60_000;

const enc = new TextEncoder();

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** Constant-time string comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface PasswordHash {
  hash: string;
  salt: string;
  iterations: number;
}

/** Decoy hash so login runs an equivalent PBKDF2 even for unknown emails (timing). */
export const DUMMY_PASSWORD_HASH: PasswordHash = {
  hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  salt: "AAAAAAAAAAAAAAAAAAAAAA==",
  iterations: PBKDF2_ITERATIONS,
};

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const bits = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return { hash: toB64(bits), salt: toB64(salt), iterations: PBKDF2_ITERATIONS };
}

export async function verifyPassword(
  password: string,
  stored: PasswordHash,
): Promise<boolean> {
  const bits = await deriveBits(password, fromB64(stored.salt), stored.iterations);
  return timingSafeEqual(toB64(bits), stored.hash);
}

function toB64Url(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hash bearer/reset tokens before persistence so a D1 leak cannot reveal them. */
export async function hashOpaqueToken(token: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(token))));
}

export function randomOpaqueToken(prefix: "wtm" | "reset" | "connect"): string {
  return `${prefix}_${toB64Url(crypto.getRandomValues(new Uint8Array(SESSION_BYTES)))}`;
}

export interface NewSession {
  id: string;
  userId: string;
  token: string;
  tokenHash: string;
  client: string;
  scope: "full" | "capture";
  createdAt: number;
  expiresAt: number;
}

function normalizeClient(client: unknown): string {
  return typeof client === "string" && client.trim() ? client.trim().slice(0, 128) : "Unknown client";
}

export async function prepareSession(
  userId: string,
  client?: unknown,
  scope: "full" | "capture" = "full",
): Promise<NewSession> {
  const token = randomOpaqueToken("wtm");
  const createdAt = Date.now();
  return {
    id: crypto.randomUUID(),
    userId,
    token,
    tokenHash: await hashOpaqueToken(token),
    client: normalizeClient(client),
    scope,
    createdAt,
    expiresAt: createdAt + SESSION_TTL_MS,
  };
}

export function insertSessionStatement(db: D1Database, session: NewSession): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sessions (id,user_id,token_hash,client,scope,created_at,last_seen_at,expires_at)
       VALUES (?1,?2,?3,?4,?5,?6,?6,?7)`,
    )
    .bind(
      session.id,
      session.userId,
      session.tokenHash,
      session.client,
      session.scope,
      session.createdAt,
      session.expiresAt,
    );
}

export interface SessionClaims {
  sessionId: string;
  userId: string;
  email: string;
  scope: "full" | "capture";
}

/** Resolve one opaque bearer token and occasionally refresh its activity time. */
export async function verifySession(db: D1Database, token: string): Promise<SessionClaims | null> {
  if (!token.startsWith("wtm_")) return null;
  const now = Date.now();
  const tokenHash = await hashOpaqueToken(token);
  const row = await db
    .prepare(
      `SELECT s.id AS session_id, s.user_id, s.last_seen_at, s.scope, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?1 AND s.expires_at > ?2`,
    )
    .bind(tokenHash, now)
    .first<{
      session_id: string;
      user_id: string;
      last_seen_at: number;
      scope: "full" | "capture";
      email: string;
    }>();
  if (!row) return null;
  if (now - row.last_seen_at >= LAST_SEEN_WRITE_INTERVAL_MS) {
    await db.prepare("UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2").bind(now, row.session_id).run();
  }
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email,
    scope: row.scope,
  };
}
