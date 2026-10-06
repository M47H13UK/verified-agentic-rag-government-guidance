import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Tests that use MongoDB each create their own database, so files can run in parallel.
    testTimeout: 15_000,
  },
});
