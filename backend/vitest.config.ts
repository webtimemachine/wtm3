import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.dev.jsonc" },
      miniflare: {
        d1Databases: ["LEGACY_DB"],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            new URL("./migrations", import.meta.url).pathname,
          ),
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
