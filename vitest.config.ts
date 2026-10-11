import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/*/src/**/*.test.ts",
      "apps/*/scripts/*.test.ts",
      "lint/*.test.ts",
    ],
    // Test files at the same time: 4, and never more than the CPUs less one
    // (Vitest's own default; 3 on CI's 4 CPUs, where 4 doubled the chat's
    // time). On this Mac's 10 CPUs, 4 was as fast as 9, alone or beside
    // another run, and starts fewer Codex and PDF processes at once.
    maxWorkers: Math.max(1, Math.min(4, availableParallelism() - 1)),
    globalSetup: ["apps/server/tests/run-folder.ts"],
    setupFiles: ["apps/server/tests/scratch-home.ts"],
  },
});
