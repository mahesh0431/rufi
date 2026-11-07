// The page a reply's visual draws in (ADR 0034). A visual is the AI's HTML,
// in a `rufi-visual` block of its reply; the screens show it in a frame of
// this page, which holds nothing until the reply's screen sends it the HTML
// and Rufi's theme. Its policy, in place of the screens' own, makes it an
// opaque origin (no cookies, storage or reach into Rufi's page) that loads
// and sends nothing: no connections, no outside script, style, picture,
// font, frame or form. The screens' frame-src keeps the frame from moving
// itself to another origin. The page's script writes the visual in with the
// card script below first: it removes WebRTC, which no policy covers, and
// tells the screen the visual's height and whether part of it didn't load.
// The messages are the same for every screen that draws a visual (ADR 0034).
import type { App } from "./http.ts";

/** Where the page is, on either listener. */
const VISUAL_FRAME_PATH = "/visual-frame.html";

/** Its own policy: in place of the screens', not beside it. */
const VISUAL_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

/**
 * The visual's own document runs this first, with the theme. Rufi's theme
 * as CSS variables, under its own names (tokens.css), and the base look:
 * no background, Rufi's text and font at the chat's size. Then the height,
 * each time it changes, and once, that something didn't load or failed.
 */
const CARD = `(theme) => {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"]) {
    try { delete window[name]; } catch {}
  }
  const parent = window.parent;
  const style = document.createElement("style");
  document.head.append(style);
  const BASE = "html{background:transparent;color:var(--ink);font-family:var(--font-ui);line-height:1.5;-webkit-text-size-adjust:100%}body{margin:0;display:flow-root}";
  const paint = (t) => {
    if (!t || typeof t !== "object") return;
    let css = ":root{color-scheme:" + (t.scheme === "dark" ? "dark" : "light") + ";";
    if (typeof t.fontSize === "string") css += "font-size:" + t.fontSize.replace(/[;{}<>]/g, "") + ";";
    const variables = t.variables && typeof t.variables === "object" ? t.variables : {};
    for (const [name, value] of Object.entries(variables)) {
      if (/^--[a-z0-9-]+$/.test(name)) css += name + ":" + String(value).replace(/[;{}<>]/g, "") + ";";
    }
    style.textContent = css + "}" + BASE;
  };
  paint(theme);
  addEventListener("message", (event) => {
    if (event.source === parent && event.data && event.data.type === "rufi-visual-theme") paint(event.data.theme);
  });
  let height = -1;
  const measure = () => {
    if (!document.body) return;
    const now = Math.ceil(document.body.getBoundingClientRect().height);
    if (now === height) return;
    height = now;
    parent.postMessage({ type: "rufi-visual-height", height: now }, "*");
  };
  let broken = false;
  const broke = () => {
    if (broken) return;
    broken = true;
    parent.postMessage({ type: "rufi-visual-broken" }, "*");
  };
  document.addEventListener("securitypolicyviolation", broke);
  addEventListener("error", broke, true);
  // The root's size follows the body's; it is there from the start.
  new ResizeObserver(measure).observe(document.documentElement);
  addEventListener("load", measure);
}`;

/** JSON that can sit inside a script element: no "</script>" in it. */
const inScript = (value: unknown) =>
  JSON.stringify(value).replace(/</g, "\\u003c");

/**
 * The page's own script: it takes the visual once, from the screen that
 * framed it, and writes it in with the card script first. The written
 * document keeps this page's policy.
 */
const HOST = `(() => {
  const parent = window.parent;
  if (parent === window) return;
  const card = ${inScript(CARD)};
  const take = (event) => {
    const data = event.data;
    if (event.source !== parent || !data || data.type !== "rufi-visual" || typeof data.html !== "string") return;
    removeEventListener("message", take);
    const theme = JSON.stringify(data.theme ?? null).replace(/</g, "\\\\u003c");
    document.open();
    document.write('<!doctype html><html><head><meta charset="utf-8"><script>(' + card + ')(' + theme + ')</' + 'script></head><body>' + data.html + '</body></html>');
    document.close();
  };
  addEventListener("message", take);
})();`;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Visual</title></head><body><script>${HOST}</script></body></html>`;

/** Serves the page a visual draws in, with its own policy. */
export function visualFrameRoute(app: App): void {
  app.get(VISUAL_FRAME_PATH, (c) => {
    c.header("Content-Security-Policy", VISUAL_CSP);
    c.header("X-DNS-Prefetch-Control", "off");
    c.header("Cache-Control", "no-store");
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body(PAGE);
  });
}
