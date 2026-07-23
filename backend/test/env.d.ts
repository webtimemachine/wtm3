import type { Env } from "../src/env";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
    LEGACY_DB: D1Database;
  }
}
