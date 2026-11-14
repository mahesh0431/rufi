# 0037 · A visual is styled with Tailwind, and its charts drawn by Chart.js, in Rufi's theme

**Date:** 15 Nov 2026 · **Status:** accepted · Adds to [ADR 0034](0034-a-replys-visual-is-an-html-block-in-a-locked-frame.md)

Rufi AI wrote each visual's look from nothing: its own `<style>`, its own sizes and corners, so no two looked alike. Mahesh chose on 14 and 15 Nov 2026 that a visual is styled with Tailwind, the CSS the Mac's screens use, in Rufi's own theme, light or dark, at the person's text size, and that its charts are drawn by Rufi with Chart.js. ADR 0034 said a visual uses no framework or chart library and that the AI works out positions itself; this changes both. Its two rules hold as they are: no script of the AI's runs in a visual, and nothing in it reaches the network. Only Rufi's own scripts run, by their hashes.

## How Tailwind gets in

The frame page carries Tailwind's own in-browser compiler, `@tailwindcss/browser`, at the version of the Mac's `tailwindcss`. It styles whatever classes the visual uses, in the frame, from Rufi's theme.

- **The visual's own script.** The screens' build makes one file, `dist/frame/visual.js` (from `src/frame/visual.ts`, built with the screens by `apps/web/vite.config.ts`, so `watch` makes it too). The core reads it when it starts, from the screens' folder, and won't start without it. The frame page writes it into the visual's document with the card script, and its policy allows it by its hash, beside the page's and the card script's. The page's policy, its second policy (no script files), its markup guard and its sandbox don't change.
- **Rufi's theme.** The document's head holds Rufi's Tailwind theme (`<style type="text/tailwindcss">`): Tailwind's own colours and shadows are off, and the theme's variables are the colours under the screens' names (`bg-surface`, `text-ink`, `border-line`, …), as `apps/web/src/themes.css` names them. So `bg-red-500` has no colour in a visual, as on the screens. `dark:` follows Rufi's theme (the card script marks `<html data-theme>`), never the system's: Rufi's appearance is its own setting.
- **The screens' sizes.** As on the screens (`apps/web/src/styles.css`), the root is the chat's text size × 16 ÷ 13 and the body's text 0.8125rem, so a class is the same size in a visual as on a screen (`text-sm` is 14 px at the default 13 px text). The theme message still sends the chat's text size.
- **Tailwind's base** (Preflight) comes with it, as Tailwind always has it, because the AI writes Tailwind expecting it. Rufi's base gives a table's cells a little room under it, so a table with no style of its own doesn't run its values together. The card script's base and the visual's own `<style>` still come after Tailwind's.

## Why the browser build

Tailwind's docs call its browser build "for development": a site would compile its classes on every load, from a CDN. The production way scans source files when the site is built, and the AI's classes don't exist until it writes them. A prebuilt file of a fixed set of classes was measured at 288 KB for the common classes alone, larger than the browser build's 279 KB, and any class outside it does nothing, with no sign. In a visual, the compiler is Rufi's own file, inside the page, with no network. This is the one place Rufi uses a library outside its docs' advice.

## What keeps CSS from reaching out

The policy, not Tailwind. Tailwind passes a web `@import` and a `url(…)` in a class such as `bg-[url(…)]` through to the CSS it writes; the frame's policy refuses both, as it refuses the same in the AI's own `<style>`. (A visual's own import comes after Rufi's theme, where the browser ignores it.) Tailwind itself refuses a plugin or a config file (`@plugin`, `@config`): its browser build loads no module. `apps/web/e2e/visual.spec.ts` checks each, in Chromium and WebKit: each import and each class's address, to the web and to Rufi's own address, waits for the browser's refusal of that address; the plugin waits for Tailwind's refusal; and a listener counts every connection. It also checks that a script file named by any of the allowed hashes never loads.

## Charts, with Chart.js

The AI drew a chart in SVG, working out every point's position itself: a point could land in the wrong place with nothing to catch it, and its text shrank to about 5 px on a phone. Now the AI writes the chart's data and Rufi draws it.

- **The AI writes JSON where the chart goes:** a Chart.js config in an HTML data block, `<script type="application/json" data-rufi-chart aria-label="…">{…}</script>`, which never runs. Before the markup guard takes out every `script`, the frame page puts a `canvas` in each block's place, holding its text in an attribute, so nothing of the AI's runs and its text is never read as HTML again. The visual's own script reads it with `JSON.parse` and gives Chart.js only its `type`, `data` and `options`. JSON holds no function; a top-level `plugins` (Chart.js's own code hooks) is left out.
- **Only the parts Rufi needs:** line, bar and scatter charts; linear, category and time scales, dates through the official date-fns adapter; the filler, legend and tooltip. Chart.js 4.6.1, pinned. A chart of any other type, a block that isn't JSON, or a config that throws (an option written as a string where Chart.js wants a function throws when it is used) says "Part of this visual didn't load", and the visual's words stay.
- **Rufi's look.** Labels in the theme's muted colour, grid lines in its line colour, its font at the Mac trend's label size. A series with no colour of its own takes, in turn, ink, accent, muted, then the same three dashed, and each its own point shape, shown in the legend: in White and Graphite the accent is almost the ink. Bars, with no shape, differ by fill: solid, soft, outline. No colour says anything about a value. When the theme changes, every chart takes the new colours and size and draws again, without reloading.
- **Rufi's own:** a chart sizes with its box, has no animation, and its tooltip is Rufi's. A larger text size makes a chart taller by as much (its shape, the AI's or 2:1, is for the default size), so its labels never squash the plot.
- **A chart says only what the record holds.** Chart.js's own tooltip prints the coordinate (`1` for "1.0", `0.5` for "<0.5") and a full date and time for "2025-03". So the AI gives each point its value as printed (`"text"`), and the tooltip shows the point's date as written, at its precision (from `y` in a horizontal chart), and that text. A point without it has no tooltip, and a point with no date as written has no title. Rufi's tooltip is the chart's and each series' own.
- **A time axis's step moves on, or the chart fails.** Chart.js adds its step until the axis ends. date-fns adds a day or a month only whole and gives an unknown unit ("days") back unchanged, so half a day or a "days" step would add nothing, and the visual would hang. Rufi's date adapter throws when a step doesn't move on, and the visual says part of it didn't load, as for any chart that fails.
- **Dates in the screen's time zone.** The time scale places "2025-03" at 1 March, 00:00 where the screen is, as it writes its ticks.
- **In every frame.** The visual's own script is one file with Tailwind and Chart.js: 510 KB, 147 KB gzipped. The frame page is one page with one policy, so a visual without a chart carries it too. On the Mac, 20 frames with a chart each drew in under half a second.

`apps/web/e2e/visual.spec.ts` checks, in Chromium and WebKit, that a chart's JSON holding markup as text, options written as strings, `__proto__` and `constructor` keys, a top-level `plugins` or web addresses draws, runs nothing, pollutes nothing and reaches no address, with the pointer on its point and a tap on its point and its legend; and that a block cut short by a closing `</script>`, a block that isn't JSON and a type Rufi doesn't draw each say their visual didn't load. It reads a chart where the browser draws it, on the canvas. Chart.js calls an option only when it is a function, and its merging skips `__proto__`, `prototype` and `constructor` keys.

## Stored visuals

A reply is stored as written. Old visuals still draw, and their content stays readable: Preflight makes headings, lists and paragraphs with no style of their own plainer, every box measures `border-box`, and an `svg` is a block; text sized in `rem` grows by about a quarter. Before dogfood, Tailwind and Chart.js are upgraded freely. After it, upgrading either is a decision, since stored visuals keep Tailwind's class names and Chart.js's config keys.

## Considered

- **A prebuilt CSS file of a fixed set of classes:** larger, and silent for any class outside it (above).
- **Compiling in the screens and sending the CSS with the visual:** each screen would carry the compiler, the iPhone's card page too; nothing smaller.
- **A CSS kit of Rufi's own:** the AI already knows Tailwind, and the screens use it.
- **Leaving Preflight out:** the AI writes Tailwind expecting it.
- **A list of the chart options a visual may use:** the reviews found no way out through an option, and the tests above would catch one.
- **Chart.js only in a frame with a chart:** the frame page is one page with one policy.
- **A value on each point:** Chart.js has no point labels without a plugin, and the one plugin for it has had no release since 2022. The values are printed beside the chart.
