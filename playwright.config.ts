import { defineConfig } from "@playwright/test";

// The screens on the real core, in Chromium. Each test starts its own core on
// a fictional data folder with the scripted Codex (apps/web/e2e/rufi.ts).
export default defineConfig({
  testDir: "apps/web/e2e",
  outputDir: "node_modules/.playwright",
  fullyParallel: true,
  forbidOnly: process.env["CI"] !== undefined,
  reporter: "list",
  use: { browserName: "chromium", trace: "retain-on-failure" },
});
