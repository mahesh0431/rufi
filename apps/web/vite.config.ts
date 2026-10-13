import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { readFile, writeFile } from "node:fs/promises";
import { build, defineConfig, type Plugin } from "vite";

/**
 * The diagram frame: its page (src/diagram/frame.html, served as
 * /diagram.html) and its script (src/diagram/frame.ts), built after the
 * screens as one plain script with a content hash, in assets/diagram/. The
 * frame runs in an opaque origin, where a module script would need CORS.
 */
function diagramFrame(): Plugin {
  return {
    name: "rufi-diagram-frame",
    apply: "build",
    async closeBundle() {
      const out = await build({
        configFile: false,
        logLevel: "warn",
        publicDir: false,
        build: {
          outDir: "dist/assets/diagram",
          emptyOutDir: false,
          chunkSizeWarningLimit: 6_000,
          lib: {
            entry: "src/diagram/frame.ts",
            formats: ["iife"],
            name: "RufiDiagram",
          },
          rolldownOptions: {
            output: {
              codeSplitting: false,
              entryFileNames: "diagram-[hash].js",
            },
          },
        },
      });
      const [result] = Array.isArray(out) ? out : [out];
      if (!("output" in result)) {
        throw new Error("The diagram frame didn't build.");
      }
      const script = result.output[0].fileName;
      const page = await readFile("src/diagram/frame.html", "utf8");
      await writeFile(
        "dist/diagram.html",
        page.replace("%DIAGRAM_SCRIPT%", `/assets/diagram/${script}`),
      );
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    diagramFrame(),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // One file is fine: the core serves it from this Mac, never over a network.
    chunkSizeWarningLimit: 1_000,
  },
});
