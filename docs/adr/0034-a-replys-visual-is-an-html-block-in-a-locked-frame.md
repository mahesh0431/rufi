# 0034 · A reply's visual is an HTML block in a locked frame

**Date:** 8 Nov 2026 · **Status:** accepted · Supersedes [ADR 0030](0030-rufi-ais-reply-is-openui-lang.md) · Its look is Tailwind's, in Rufi's theme: [ADR 0037](0037-a-visual-is-styled-with-tailwind-in-rufis-theme.md)

Rufi AI's reply is Markdown, no longer OpenUI Lang. Where a chart, a comparison, many values side by side or a process shows better than words, the AI writes a small visual in HTML and CSS, with inline SVG for a chart, as a block in its reply, in the place it belongs. Rufi shows the block as a card. Mahesh chose this on 7 Nov 2026: "HTML, CSS sort of thing", with no chart library or framework, drawn with Rufi's theme. Two rules hold in code, not only in the AI's instructions: a visual can't reach the network, so it never sends health data out, and it can't touch the app or its session. So a visual runs no script of its own (8 Nov 2026).

## The block

A visual is a fenced code block whose info string starts with the word `rufi-visual`, at the reply's top level, as CommonMark reads a fence:

- it opens with up to three spaces, then three or more backticks or tildes, then the info string;
- it closes at the next line of the same character, at least as many, with nothing else on the line.

Its content is an HTML fragment for a document's body, with a `<style>` when it needs one. A `<script>` in it never runs, and the frame takes it out (below).

````markdown
Your HbA1c went down over the year.

```rufi-visual
<svg viewBox="0 0 320 160" width="100%">…</svg>
```

It is now under the lab's 6.0 % line.
````

- **The reply is stored as written, and read as one Markdown document.** Nothing is extracted or copied. A link before a visual still finds its definition after it. Any other fence stays code, also one that shows a `rufi-visual` block inside it, or one inside a list or quote.
- **While the reply is written,** a visual is whole once its closing fence is in the text. An unclosed one runs to the end, as a fence does, and draws once the reply ended. Until it is whole, a quiet box holds its place, and its code never shows.
- **Any screen that draws visuals finds them the same way,** as its Markdown parser reads the reply's top-level fences. The web screens mark them in the reply's parsed document (`apps/web/src/visual-blocks.ts`) and draw them there. Wherever Rufi doesn't draw visuals, such as an agent's message, the block shows as code, never as live HTML.

**Why a fence, not a raw HTML tag.** CommonMark ends a raw HTML block at its first blank line, except for a handful of tags. The AI's HTML and CSS have blank lines, and the rest would read as Markdown. A fence keeps every character to its closing fence, makes "whole" one clear rule, and reads as code anywhere it isn't drawn.

## The frame

The screens draw each visual in a frame of `/visual-frame.html`, a page the core serves on both listeners, the Mac's and the remote door's (`apps/server/src/server/visual-frame.ts`).

- **The page holds nothing.** It loads with no visual in it and waits for one message from the screen that framed it: `{type: "rufi-visual", html, theme}`. Then its script:
  1. parses the HTML in a `<template>`, where nothing loads or runs;
  2. takes out every `link`, `meta`, `base`, `script`, `iframe`, `frame`, `object`, `embed` and `area`: elements with no job in a drawing of HTML, CSS and SVG that can reach out. Every `a`, HTML and SVG, gives way to what it holds: a visual has no links, and its words stay;
  3. writes in a document whose head holds the theme as JSON (a `<script type="application/json" id="rufi-theme">`, data that never runs) and the card script, which keeps the page's own policy;
  4. puts the parsed visual in its body, never parsing it a second time.
- **The screen sends it on every load of the frame.** A browser loads a frame again when it moves in the page, as a reply's line can when the reply ends, and that frame is empty until it gets the visual again; a visual already written in takes no second one.
- **Its policy replaces the screens' own.** It is two policies in one header, by a comma, and the browser holds each:

  ```
  sandbox allow-scripts; default-src 'none'; script-src 'sha256-<the page's script>' 'sha256-<the card script>'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self', script-src 'unsafe-inline'
  ```

  Only the page's two scripts run, by their hashes: no script of the visual's, inline or in an attribute such as `onload`. A hash alone would also allow a script file whose `integrity` names it, and the file's request, with whatever its address holds, leaves before the file is checked. The second policy allows no script file at all. Connections, frames and workers fall back to `default-src 'none'`. It also sends `X-DNS-Prefetch-Control: off` and `no-store`.

- **The frame element:** `sandbox="allow-scripts"` (for the page's own two scripts), `referrerpolicy="no-referrer"`, titled "Visual". With no other sandbox flag, it gets no popups, top navigation, forms or same-origin access.

**Why a served page, not `srcdoc` or a `blob:` frame.** Both inherit the policy of the page that made them. The screens' policy (`script-src 'self'; style-src 'self'`, ADR 0017's strictness) refuses the visual's inline style and the page's own scripts, and Rufi's own policy is never loosened. A page the core serves carries its own policy in place of Rufi's. This is the pattern of Rufi's old diagram frame (ADR 0017), and of hosts that take HTML apps by message into a sandboxed page.

## The two rules

**Nothing reaches the network.** Two layers, each tested in Chromium and WebKit (`apps/web/e2e/visual.spec.ts`), with a listener that counts every connection as well as every request. The hostile visual tests the markup; a script file put in past the markup, by the test itself, tests the second policy on its own.

- **The markup:** what can reach out is taken out before the visual is live. Some ways out are no request a policy sees: WebKit opens a `preconnect` link's connection, and looks up a `dns-prefetch` link's name, whatever the policy says, and connects to a `target="_blank"` link's or an image map's address when it is clicked, though the new window never opens.
- **No links.** A clicked link moves the frame, and a policy can't stop a move to Rufi's own address, which would get whatever the link's address holds (WebKit sends Rufi's session cookie with it, though the API still refuses it). So a visual has no `a` and no `area`, and its links are words. Links go in the reply's text.
- **No script of the visual's runs.** CSP doesn't cover every way out: WebRTC, for one, isn't covered, as no browser enforces CSP's `webrtc` directive. A visual that can't run script can't use them. A chart is inline SVG and CSS, with positions the AI works out itself.
- The policies refuse every connection, outside script, style, picture, font, frame, worker and form.
- **Nothing moves the frame.** With no link, `meta`, form or script, a visual can't. Behind that, the screens' own `frame-src` is `blob: 'self'`: a frame can't move to another origin. Rufi's own pages refuse to be framed (`frame-ancestors 'none'`), and its API needs the tab proof that a frame doesn't have.
- **The Mac app** stops any frame leaving Rufi (`will-frame-navigate`), and a visual's frame, or anything inside it, doesn't count among the frames that keep a link from opening in the browser: its sandbox and policy forbid popups.
- **The iPhone app's web view** opens only the page's own web links in Safari; a frame's web navigation is cancelled (`Screens.route`).
- **DNS prefetch**, which a link in HTML alone can start and CSP doesn't cover, is turned off by the header, and a page can't turn it on again.

**Nothing of the app or its session.** The sandbox gives the visual an opaque origin: no cookies, no storage, and no reach into Rufi's page. The screen sends it only its HTML and the theme. It reads back only three messages, from that frame alone, and nothing else: the two below, and a button's message ([ADR 0035](0035-a-visuals-button-sends-its-words-as-the-persons-message.md)).

## The theme

The theme is `{scheme, fontSize, variables}`:

- `scheme` is `"light"` or `"dark"`;
- `fontSize` is the chat's text size as CSS, such as `"13px"`;
- `variables` are Rufi's tokens under their own names, from `packages/brand/tokens.css`, as the page computes them:

  ```
  --page  --surface  --side  --line  --ink  --muted
  --accent  --accent-soft  --accent-ink  --on-accent  --font-ui
  ```

The card script sets them on `:root`, with `color-scheme`, under a base look: no background, `var(--ink)` text in `var(--font-ui)` at the chat's size, and a body with no margin. `--font-ui` is the system's font, so nothing loads.

When the theme, colour or text size changes, the screen sends `{type: "rufi-visual-theme", theme}`, and the visual takes it without reloading. The AI's instructions tell it to use these names.

## The messages back

Both are posted to the framing page (a third, a button's message, is in [ADR 0035](0035-a-visuals-button-sends-its-words-as-the-persons-message.md)):

- **`{type: "rufi-visual-height", height}`** gives the body's height in CSS pixels, when it is first known and each time it changes (a `ResizeObserver`). The screen draws the frame at that height, up to 800 px; a taller visual scrolls inside.
  - Until the first height comes, the frame keeps a 160 px quiet box.
  - When a visual that starts above what the person reads changes height, the chat moves the view by as much, so what they read doesn't jump. At the chat's end, it follows as it always does.
  - A browser doesn't draw a frame that is wholly out of view, so such a visual reports a change of height only once it shows.
- **`{type: "rufi-visual-broken"}`** is sent once, when the policy refused something (a `securitypolicyviolation`, such as a picture from outside) or a resource failed (an `error`).
  - The visual stays as drawn, perhaps blank, and the screen says under it "Part of this visual didn't load". It says the same for a visual whose height is 0, such as one the frame took everything out of. There is no button: the person can ask again.
  - The usual cause is a model reaching for a script or a chart library on a CDN, which the instructions tell it not to do.

## For a screen of its own, such as the iPhone's native chat

It finds blocks by the same fence rule, sends the same theme names, and acts on the same three messages: the two above, and a button's message ([ADR 0035](0035-a-visuals-button-sends-its-words-as-the-persons-message.md)). It draws each visual in a frame of this same page, from the core it reaches (the remote door on the iPhone), so the guard and the policies are one implementation:

- The page writes a visual in only when it is framed: as the top document it does nothing, and `frame-ancestors 'self'` lets only a page of the core's own origin frame it.
- The headers must reach the web view as the core sends them. WebKit holds both comma-joined policies (the WebKit test above). A page loaded with `loadHTMLString` has no headers, so it can't be the visual's page.
- Its web view stops any navigation that leaves, as the iPhone's does (`Screens.route`).

## Considered

- **A raw `<rufi-visual>` tag** (above).
- **`srcdoc` or a `blob:` frame** (above).
- **A height the AI declares:** models guess pixel heights badly. The measured height and the kept place remove the jump.
- **T3 Code's server-side measuring at several widths:** a headless browser in the core for something the kept place already solves.
- **A separate tool call for a visual:** a block in place keeps the reply one stored text, streamed and read as written.
- **Inline script for drawing, with WebRTC removed before it runs:** a visual's script can make a blank frame of its own, which no frame policy covers, and take WebRTC from it.
- **The policy alone:** it doesn't cover WebKit's link hints, and a hash allows a script file that names it.
- **Taking elements out after the visual is written in,** such as by a `MutationObserver`: a link starts its connection as it is parsed, before any observer sees it.
- **A general HTML sanitizer library:** a short list of elements, taken out of an inert parse, is all a drawing needs; the policies hold the rest.
- **A cap on how often a visual loads its frame:** with no `meta` and no script, a visual can't load itself again.

**Not now:**

- links in a visual;
- full screen;
- a palette for several series;
- drawing only the visuals near the view.
