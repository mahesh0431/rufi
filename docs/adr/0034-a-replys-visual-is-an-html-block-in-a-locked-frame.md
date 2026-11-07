# 0034 · A reply's visual is an HTML block in a locked frame

**Date:** 8 Nov 2026 · **Status:** accepted · Supersedes [ADR 0030](0030-rufi-ais-reply-is-openui-lang.md)

Rufi AI's reply is Markdown, no longer OpenUI Lang. Where a chart, a comparison, many values side by side or a process shows better than words, the AI writes a small visual in HTML and CSS, with inline script to draw if it needs one, as a block in its reply, in the place it belongs. Rufi shows the block as a card. Mahesh chose this on 7 Nov 2026: plain HTML, CSS and JS, with no chart library or framework, drawn with Rufi's theme. Two rules hold in code, not only in the AI's instructions: a visual can't reach the network, so it never sends health data out, and it can't touch the app or its session.

## The block

A visual is a fenced code block whose info string starts with the word `rufi-visual`, at the reply's top level, as CommonMark reads a fence:

- it opens with up to three spaces, then three or more backticks or tildes, then the info string;
- it closes at the next line of the same character, at least as many, with nothing else on the line.

Its content is an HTML fragment for a document's body. A `<style>` and a `<script>` may be in it.

````markdown
Your HbA1c went down over the year.

```rufi-visual
<svg viewBox="0 0 320 160" width="100%">…</svg>
```

It is now under the lab's 6.0 % line.
````

- **The reply is stored as written.** Nothing is extracted or copied, and the stored reply is plain Markdown. Any other fence stays code, also one that shows a `rufi-visual` block inside it.
- **While the reply is written,** a visual is whole once its closing fence is in the text. An unclosed one runs to the end, as a fence does, and draws once the reply ended. Until it is whole, a quiet box holds its place, and its code never shows.
- **Any screen that draws visuals finds them the same way:** a line scan for the opening fence and the next closing one (`apps/web/src/visual-blocks.ts`). Wherever Rufi doesn't draw visuals, such as an agent's message, the block shows as code, never as live HTML.

**Why a fence, not a raw HTML tag.** CommonMark ends a raw HTML block at its first blank line, except for a handful of tags. The AI's CSS and script have blank lines, and the rest would read as Markdown. A fence keeps every character to its closing fence, makes "whole" one clear rule, and reads as code anywhere it isn't drawn.

## The frame

The screens draw each visual in a frame of `/visual-frame.html`, a page the core serves on both listeners, the Mac's and the remote door's (`apps/server/src/server/visual-frame.ts`).

- **The page holds nothing.** It loads with no visual in it and waits for one message from the screen that framed it: `{type: "rufi-visual", html, theme}`. Its script then writes in a document whose head runs the card script with the theme, and whose body is the visual's HTML. Writing it in keeps the page's own policy.
- **Its policy replaces the screens' own:**

  ```
  sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'
  ```

  It also sends `X-DNS-Prefetch-Control: off` and `no-store`. There is no `unsafe-eval`, because a visual uses no library.

- **The frame element:** `sandbox="allow-scripts"`, `referrerpolicy="no-referrer"`, titled "Visual". With no other sandbox flag, it gets no popups, top navigation, forms or same-origin access.

**Why a served page, not `srcdoc` or a `blob:` frame.** Both inherit the policy of the page that made them. The screens' policy (`script-src 'self'; style-src 'self'`, ADR 0017's strictness) refuses the visual's inline style and script, and Rufi's own policy is never loosened. A page the core serves carries its own policy in place of Rufi's. This is the pattern of Rufi's old diagram frame (ADR 0017), and of hosts that take HTML apps by message into a sandboxed page.

## The two rules

**Nothing reaches the network.**

- The policy refuses every connection, outside script, style, picture, font, frame, worker and form.
- The screens' own `frame-src` is `blob: 'self'`: a visual's frame can't move itself to another origin. Rufi's own pages, its only other address, refuse to be framed (`frame-ancestors 'none'`), and its API needs the tab proof that a frame doesn't have.
- **The Mac app** stops any frame leaving Rufi (`will-frame-navigate`), and a visual's frame, or anything inside it, doesn't count among the frames that keep a link from opening in the browser: its sandbox and policy forbid popups.
- **The iPhone app's web view** opens only the page's own web links in Safari; a frame's web navigation is cancelled (`Screens.route`).
- **Two channels CSP doesn't cover:**
  - **DNS prefetch** is turned off by the header, and a page can't turn it on again.
  - **WebRTC.** No browser enforces CSP's `webrtc` directive, so the card script deletes `RTCPeerConnection`, `webkitRTCPeerConnection` and `RTCDataChannel` before the visual's script runs.
  - **Known limit:** a visual's script can still make a blank frame of its own (the policy's `frame-src` doesn't cover `about:blank`) and take WebRTC from it. Only a visual written to do so on purpose, by an AI misled by what it read, could. Closing it fully means a visual runs no script of its own.

**Nothing of the app or its session.** The sandbox gives the visual an opaque origin: no cookies, no storage, and no reach into Rufi's page. The screen sends it only its HTML and the theme. It reads back only two messages, from that frame alone, and nothing else.

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

Both are posted to the framing page:

- **`{type: "rufi-visual-height", height}`** gives the body's height in CSS pixels, when it is first known and each time it changes (a `ResizeObserver`). The screen draws the frame at that height, up to 800 px; a taller visual scrolls inside.
  - Until the first height comes, the frame keeps a 160 px quiet box.
  - When a visual that starts above what the person reads changes height, the chat moves the view by as much, so what they read doesn't jump. At the chat's end, it follows as it always does.
  - A browser doesn't draw a frame that is wholly out of view, so such a visual reports a change of height only once it shows.
- **`{type: "rufi-visual-broken"}`** is sent once, when the policy refused something (a `securitypolicyviolation`) or a script or resource failed (an `error`).
  - The visual stays as drawn, perhaps blank, and the screen says under it "Part of this visual didn't load". There is no button: the person can ask again.
  - The usual cause is a model reaching for a chart library on a CDN, which the instructions tell it not to do.

## For a screen of its own, such as the iPhone's native chat

It finds blocks by the same fence rule, sends the same theme names, and acts on the same two messages. It may host a visual its own way, such as a web view of its own with `loadHTMLString`, under its own policy. That policy must hold both rules: no connections and no outside resources, no access to the app or its session, and no navigation that leaves.

## Considered

- **A raw `<rufi-visual>` tag** (above).
- **`srcdoc` or a `blob:` frame** (above).
- **A height the AI declares:** models guess pixel heights badly. The measured height and the kept place remove the jump.
- **T3 Code's server-side measuring at several widths:** a headless browser in the core for something the kept place already solves.
- **A separate tool call for a visual:** a block in place keeps the reply one stored text, streamed and read as written.

**Not now:**

- links in a visual;
- full screen;
- a palette for several series;
- drawing only the visuals near the view.
