import type { UserInfo } from "@wtm/shared";
import type { Env } from "./env";

export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized) ? normalized : null;
}

export async function userInfo(env: Env, userId: string): Promise<UserInfo | null> {
  const row = await env.DB.prepare(
    "SELECT id, email, created_at, retention_days, filter_sensitive FROM users WHERE id = ?1",
  )
    .bind(userId)
    .first<{
      id: string;
      email: string;
      created_at: number;
      retention_days: number;
      filter_sensitive: number;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
    retentionDays: row.retention_days,
    filterSensitive: !!row.filter_sensitive,
  };
}

export async function userFilterSensitive(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT filter_sensitive FROM users WHERE id = ?1")
    .bind(userId)
    .first<{ filter_sensitive: number }>();
  return !!row?.filter_sensitive;
}

/** Revoke every MCP OAuth grant owned by a user, following provider pagination. */
export async function revokeUserOAuthGrants(env: Env, userId: string): Promise<void> {
  const grantIds: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(userId, { limit: 100, ...(cursor ? { cursor } : {}) });
    grantIds.push(...page.items.map((grant) => grant.id));
    cursor = page.cursor;
  } while (cursor);
  await Promise.all(
    grantIds.map((grantId) =>
      env.OAUTH_PROVIDER.revokeGrant(grantId, userId),
    ),
  );
}

export async function sendPasswordResetEmail(env: Env, email: string, token: string): Promise<void> {
  if (!env.EMAIL) throw new Error("EMAIL binding is not configured");
  const url = `https://webtm.io/reset?token=${encodeURIComponent(token)}`;
  await env.EMAIL.send({
    from: { email: "noreply@webtm.io", name: "Web Time Machine" },
    to: email,
    replyTo: "info@webtm.io",
    subject: "Reset your Web Time Machine password",
    text:
      `Reset your Web Time Machine password:\n\n${url}\n\n` +
      "This link expires in 30 minutes. If you did not request it, you can ignore this email.",
    html:
      `<p>Reset your Web Time Machine password:</p>` +
      `<p><a href="${url}">Choose a new password</a></p>` +
      `<p>This link expires in 30 minutes. If you did not request it, you can ignore this email.</p>`,
  });
}
