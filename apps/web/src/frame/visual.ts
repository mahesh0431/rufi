// Rufi's own script in a reply's visual (apps/server visual-frame.ts, ADR
// 0034): built on its own (vite.frame.config.ts) into one file the core
// puts in the visual's frame page and allows by its hash. It brings
// Tailwind's in-browser compiler, which styles the classes the AI writes
// with Rufi's theme (the frame's <style type="text/tailwindcss">).
import "@tailwindcss/browser";
