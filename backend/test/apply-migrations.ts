import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await applyD1Migrations(env.LEGACY_DB, [
  ...env.TEST_MIGRATIONS.slice(0, 6),
  env.TEST_MIGRATIONS[7]!,
]);
