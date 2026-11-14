// Rufi's own script in a reply's visual (apps/server visual-frame.ts, ADR
// 0034, 0037): built with the screens (vite.config.ts) into one file the
// core puts in the visual's frame page and allows by its hash. It brings
// Tailwind's in-browser compiler, which styles the classes the AI writes
// with Rufi's theme (the frame's <style type="text/tailwindcss">), and
// Rufi's charts: the page calls `draw` once the visual is in.
import "@tailwindcss/browser";

export { draw } from "./charts.ts";
