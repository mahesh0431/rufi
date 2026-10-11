import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/*/src/**/*.test.ts",
      "apps/*/scripts/*.test.ts",
      "lint/*.test.ts",
    ],
    // Test files at the same time. The run takes as long as its longest file
    // (the chat's, about 40 s) with 4 or with 9 (the default here), alone or
    // beside another run; 4 starts fewer Codex and PDF processes at once.
    maxWorkers: 4,
    globalSetup: ["apps/server/tests/run-folder.ts"],
    setupFiles: ["apps/server/tests/scratch-home.ts"],
  },
});
