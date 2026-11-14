// The visual's own script (src/frame/visual.ts), built after the screens
// into dist/frame/visual.js: one file, run as it is (no modules), which the
// core inlines in the visual's frame page (apps/server visual-frame.ts).
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist/frame",
    emptyOutDir: false,
    lib: {
      entry: "src/frame/visual.ts",
      formats: ["iife"],
      name: "rufiVisual",
      fileName: () => "visual.js",
    },
  },
});
