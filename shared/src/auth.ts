function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** Create a PKCE verifier/challenge pair for a public browser-extension client. */
export async function createPkcePair(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = toBase64Url(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  return { verifier, challenge: await pkceChallenge(verifier) };
}

/** Derive the RFC 7636 S256 challenge for a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return toBase64Url(new Uint8Array(digest));
}
