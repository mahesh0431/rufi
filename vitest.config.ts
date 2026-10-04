import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/*/src/**/*.test.ts",
      "apps/*/scripts/*.test.ts",
      "lint/*.test.ts",
    ],
  },
});
