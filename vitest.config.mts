import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname),
      // server-only throws outside a React Server Components build.
      "server-only": path.resolve(import.meta.dirname, "test/empty-module.ts"),
    },
  },
  // Each test starts its own in-memory Postgres, which takes a few seconds.
  test: { include: ["**/*.test.ts"], exclude: ["node_modules/**"], testTimeout: 30_000 },
});
