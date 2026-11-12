// The page a reply's visual draws in (ADR 0034). A visual is the AI's HTML
// and CSS, in a `rufi-visual` block of its reply; the screens show it in a
// frame of this page, which holds nothing until the reply's screen sends it
// the HTML and Rufi's theme. Two layers keep a visual from reaching the
// network or Rufi. First, the page parses the HTML where nothing loads or
// runs, and takes out the elements that have no job in a drawing and can
// reach out (REFUSED), before any of it is live. Then its policy, in place of
// the screens' own, makes it an opaque origin (no cookies, storage or reach
// into Rufi's page) that loads and sends nothing, and runs only this page's
// two scripts, by their hashes. The screens' frame-src keeps the frame from
// moving itself to another origin. The card script sets the theme and tells
// the screen the visual's height and whether part of it didn't load. Every
// screen that draws a visual uses this page (ADR 0034).
import { createHash } from "node:crypto";
import type { App } from "./http.ts";

/** Where the page is, on either listener. */
const VISUAL_FRAME_PATH = "/visual-frame.html";

/** Where the written document keeps the theme it starts with. */
const THEME_ID = "rufi-theme";

/**
 * A button that sends its message (ADR 0035): Rufi's plain button, the same
 * in every visual, in the theme's colours; the AI leaves it unstyled.
 */
const BUTTON =
  "button[data-rufi-send]{font:inherit;font-size:0.8125rem;font-weight:500;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:8px;min-height:36px;padding:0 14px;margin:4px 8px 0 0;cursor:pointer}button[data-rufi-send]:hover{background:var(--page)}button[data-rufi-send]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}@media (pointer:coarse){button[data-rufi-send]{min-height:44px}}";

/**
 * The visual's own document runs this first. Rufi's theme as CSS variables,
 * under its own names (tokens.css), and the base look: no background,
 * Rufi's text and font at the chat's size. Then the height, each time it
 * changes, and once, that something was refused or didn't load.
 */
const CARD = `(() => {
  const parent = window.parent;
  const style = document.createElement("style");
  document.head.append(style);
  const BASE = "html{background:transparent;color:var(--ink);font-family:var(--font-ui);line-height:1.5;-webkit-text-size-adjust:100%}body{margin:0;display:flow-root}${BUTTON}";
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
  try { paint(JSON.parse(document.getElementById("${THEME_ID}").textContent)); } catch {}
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
  // A button's message (ADR 0035): on a person's click or key, its words
  // go to the screen, which sends them as their message. A double click's
  // second click sends nothing more.
  document.addEventListener("click", (event) => {
    if (event.detail > 1 || !(event.target instanceof Element)) return;
    const button = event.target.closest("button[data-rufi-send]");
    const text = button ? button.getAttribute("data-rufi-send").trim() : "";
    if (text !== "") parent.postMessage({ type: "rufi-visual-send", text }, "*");
  });
  document.addEventListener("securitypolicyviolation", broke);
  addEventListener("error", broke, true);
  // The root's size follows the body's; it is there from the start.
  new ResizeObserver(measure).observe(document.documentElement);
  addEventListener("load", measure);
})();`;

/**
 * What a visual's HTML loses before it is live: the elements that have no
 * job in a drawing of HTML, CSS and SVG and can reach out. A link's hints
 * (preconnect, dns-prefetch) reach the network in WebKit whatever the policy
 * says, a script's integrity can match a hash the policy allows, and a meta
 * can refresh or set a policy of its own. A visual has no links either: its
 * `a` elements, HTML and SVG, give way to what they hold, and an image map's
 * `area` goes. A click on one reaches Rufi's own address, value in hand, and
 * one for a new window connects in WebKit though the window never opens.
 */
const REFUSED = "link, meta, base, script, iframe, frame, object, embed, area";

/** JSON that can sit inside a script element: no "</script>" in it. */
const inScript = (value: unknown) =>
  JSON.stringify(value).replace(/</g, "\\u003c");

/**
 * The page's own script: it takes the visual once, from the screen that
 * framed it. It parses the HTML in a template, which loads and runs nothing,
 * takes out what REFUSED names, and unwraps every link. It writes in a document with the theme
 * as data and the card script, which keeps this page's policy, and then puts
 * the visual in its body as parsed, never parsing it a second time.
 */
const HOST = `(() => {
  const parent = window.parent;
  if (parent === window) return;
  const card = ${inScript(CARD)};
  const take = (event) => {
    const data = event.data;
    if (event.source !== parent || !data || data.type !== "rufi-visual" || typeof data.html !== "string") return;
    removeEventListener("message", take);
    const inert = document.createElement("template");
    inert.innerHTML = data.html;
    for (const element of inert.content.querySelectorAll(${JSON.stringify(REFUSED)})) element.remove();
    for (const link of inert.content.querySelectorAll("a")) link.replaceWith(...link.childNodes);
    const theme = JSON.stringify(data.theme ?? null).replace(/</g, "\\\\u003c");
    document.open();
    document.write('<!doctype html><html><head><meta charset="utf-8"><script type="application/json" id="${THEME_ID}">' + theme + '</' + 'script><script>' + card + '</' + 'script></head><body></body></html>');
    document.close();
    document.body.append(inert.content);
  };
  addEventListener("message", take);
})();`;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Visual</title></head><body><script>${HOST}</script></body></html>`;

const hash = (script: string) =>
  `'sha256-${createHash("sha256").update(script).digest("base64")}'`;

/**
 * Its own policy, in place of the screens', not beside it: only the two
 * scripts above, inline styles, and pictures and fonts in the visual itself.
 * Connections, frames and workers fall back to none. A second policy, which
 * the browser enforces as well, allows no script from a file: a hash alone
 * allows a script file whose `integrity` names it, and its request leaves
 * before the file is checked.
 */
const VISUAL_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  `script-src ${hash(HOST)} ${hash(CARD)}`,
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");
const NO_SCRIPT_FILES = "script-src 'unsafe-inline'";

/** Serves the page a visual draws in, with its own policy. */
export function visualFrameRoute(app: App): void {
  app.get(VISUAL_FRAME_PATH, (c) => {
    // Two policies, by a comma: each holds on its own.
    c.header("Content-Security-Policy", `${VISUAL_CSP}, ${NO_SCRIPT_FILES}`);
    // A link's DNS lookup is no request a policy sees.
    c.header("X-DNS-Prefetch-Control", "off");
    c.header("Cache-Control", "no-store");
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body(PAGE);
  });
}

/** Where the iPhone's native chat loads a visual's card, on the door. */
const VISUAL_CARD_PATH = "/visual-card.html";

/**
 * The card's own script, on the iPhone (ADR 0034, "For a screen of its
 * own"): the app gives it a visual and the theme (`rufiCard.show`), and it
 * sends them to the frame of the visual's page on every load of the frame,
 * and a new theme as it comes (`rufiCard.theme`). It passes the frame's two
 * messages, the height and that part didn't load, to the app, from that
 * frame alone.
 */
const CARD_HOST = `(() => {
  const frame = document.querySelector("iframe");
  let visual = null;
  const send = () => {
    if (visual) frame.contentWindow.postMessage({ type: "rufi-visual", html: visual.html, theme: visual.theme }, "*");
  };
  frame.addEventListener("load", send);
  window.rufiCard = {
    show(html, theme) {
      visual = { html, theme };
      send();
    },
    theme(theme) {
      if (!visual) return;
      visual.theme = theme;
      frame.contentWindow.postMessage({ type: "rufi-visual-theme", theme }, "*");
    },
  };
  addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== frame.contentWindow || !data) return;
    if (data.type === "rufi-visual-height" || data.type === "rufi-visual-broken") {
      window.webkit?.messageHandlers?.card?.postMessage({ type: data.type, height: Number(data.height) || 0 });
    }
  });
})();`;

const CARD_STYLE =
  "html,body{margin:0;background:transparent}iframe{display:block;border:0;width:100%;height:100vh}";

const CARD_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Visual</title><style>${CARD_STYLE}</style></head><body><iframe src="${VISUAL_FRAME_PATH}" sandbox="allow-scripts" referrerpolicy="no-referrer" title="Visual"></iframe><script>${CARD_HOST}</script></body></html>`;

/**
 * Its policy: its own script and style by their hashes, a frame of the
 * door's own pages only (the visual's), nothing else in or out, and no page
 * may frame it.
 */
const CARD_CSP = [
  "default-src 'none'",
  `script-src ${hash(CARD_HOST)}`,
  `style-src ${hash(CARD_STYLE)}`,
  "frame-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Serves the page the iPhone's native chat loads a visual's card in: it
 * frames the visual's page, from the door's own origin as that page asks,
 * and holds nothing itself.
 */
export function visualCardRoute(app: App): void {
  app.get(VISUAL_CARD_PATH, (c) => {
    c.header("Content-Security-Policy", CARD_CSP);
    c.header("X-DNS-Prefetch-Control", "off");
    c.header("Cache-Control", "no-store");
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body(CARD_PAGE);
  });
}
