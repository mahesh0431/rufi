import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/*/src/**/*.test.ts",
      "apps/*/scripts/*.test.ts",
      "lint/*.test.ts",
    ],
    globalSetup: ["apps/server/tests/run-folder.ts"],
    setupFiles: ["apps/server/tests/scratch-home.ts"],
  },
});
