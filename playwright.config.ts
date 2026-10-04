import { defineConfig } from "@playwright/test";

// The screens on the real core, in Chromium: each test starts its own core on
// a fictional data folder with the scripted Codex (apps/web/e2e/rufi.ts).
// The Rufi app in Electron: each test runs the real `rufi start` on its own
// fictional data folder, signed out (apps/desktop/e2e/app.ts).
export default defineConfig({
  outputDir: "node_modules/.playwright",
  fullyParallel: true,
  forbidOnly: process.env["CI"] !== undefined,
  reporter: "list",
  use: { trace: "retain-on-failure" },
  projects: [
    {
      name: "screens",
      testDir: "apps/web/e2e",
      use: { browserName: "chromium" },
    },
    { name: "desktop", testDir: "apps/desktop/e2e", timeout: 60_000 },
  ],
});
