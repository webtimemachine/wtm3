import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Alias the workspace package to its TS source so Vite compiles it directly
// (more specific subpaths first).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@wtm/shared/api", replacement: r("../shared/src/api.ts") },
      { find: "@wtm/shared/format", replacement: r("../shared/src/format.ts") },
      { find: "@wtm/shared/search", replacement: r("../shared/src/search.ts") },
      { find: "@wtm/shared", replacement: r("../shared/src/index.ts") },
    ],
  },
  build: { outDir: "dist", sourcemap: true },
});
