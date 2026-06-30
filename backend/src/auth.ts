import { SignJWT, jwtVerify } from "jose";

// Cloudflare Workers' WebCrypto caps PBKDF2 at 100,000 iterations.
const PBKDF2_ITERATIONS = 100_000;
const KEY_BITS = 256;
const SALT_BYTES = 16;
const TOKEN_TTL = "90d";

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

export interface TokenClaims {
  userId: string;
  email: string;
}

export async function signToken(secret: string, claims: TokenClaims): Promise<string> {
  return await new SignJWT({ email: claims.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(enc.encode(secret));
}

export async function verifyToken(secret: string, token: string): Promise<TokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, enc.encode(secret));
    if (!payload.sub) return null;
    return { userId: payload.sub, email: String(payload.email ?? "") };
  } catch {
    return null;
  }
}
