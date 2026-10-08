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
  // File content stays in that database, never in a real Blob store.
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**"],
    testTimeout: 30_000,
    env: { BLOB_READ_WRITE_TOKEN: "", BLOB_STORE_ID: "", MACH_SECRETS_KEY: "dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdCE=" },
  },
});
