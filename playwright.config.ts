import { defineConfig } from "@playwright/test";

// The screens on the real core, in Chromium (a visual's guard in WebKit too): each test starts its own core on
// a fictional data folder with the scripted Codex (apps/web/e2e/rufi.ts).
// The Rufi app in Electron: each test runs the real `rufi start` on its own
// fictional data folder, signed out (apps/desktop/e2e/app.ts). The brand
// package's moving dog at its own API, on a blank page.
export default defineConfig({
  outputDir: "node_modules/.playwright",
  globalSetup: "apps/server/tests/run-folder.ts",
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
    // A visual's guard, its look and its buttons in WebKit, the iPhone's engine (ADR 0034, 0035, 0037).
    {
      name: "screens-webkit",
      testDir: "apps/web/e2e",
      testMatch: "visual.spec.ts",
      grep: /reaches neither the network|buttons send their messages as yours|styled with Tailwind/,
      use: { browserName: "webkit" },
    },
    { name: "desktop", testDir: "apps/desktop/e2e", timeout: 60_000 },
    {
      name: "brand",
      testDir: "packages/brand/mark",
      use: { browserName: "chromium" },
    },
  ],
});
