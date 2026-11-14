import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { build, defineConfig, type Plugin } from "vite";

/**
 * The visual's own script (src/frame/visual.ts), built with the screens
 * into dist/frame/visual.js: one file, run as it is (no modules), which the
 * core inlines in the visual's frame page (apps/server visual-frame.ts).
 * It is built in memory at each build's start and written with the
 * screens, so emptying dist keeps it, and `watch` builds again when any of
 * its sources changes.
 */
function visualScript(): Plugin {
  let code = "";
  return {
    name: "rufi-visual-script",
    apply: "build",
    async buildStart() {
      const built = await build({
        configFile: false,
        publicDir: false,
        logLevel: "warn",
        build: {
          write: false,
          lib: {
            entry: "src/frame/visual.ts",
            formats: ["iife"],
            name: "rufiVisual",
            fileName: () => "visual.js",
          },
        },
      });
      const [output] = (Array.isArray(built) ? built : [built]).flatMap(
        (result) => ("output" in result ? result.output : []),
      );
      if (output?.type !== "chunk") {
        throw new Error("The visual's script didn't build.");
      }
      code = output.code;
      for (const id of output.moduleIds) {
        if (!id.includes("/node_modules/")) this.addWatchFile(id);
      }
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "frame/visual.js",
        source: code,
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    visualScript(),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // One file is fine: the core serves it from this Mac, never over a network.
    chunkSizeWarningLimit: 1_000,
  },
});
