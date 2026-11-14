# 0037 · A visual is styled with Tailwind, in Rufi's theme

**Date:** 15 Nov 2026 · **Status:** accepted · Adds to [ADR 0034](0034-a-replys-visual-is-an-html-block-in-a-locked-frame.md)

Rufi AI wrote each visual's look from nothing: its own `<style>`, its own sizes and corners, so no two looked alike. Mahesh chose on 14 and 15 Nov 2026 that a visual is styled with Tailwind, the CSS the Mac's screens use, in Rufi's own theme, light or dark, at the person's text size. ADR 0034 said a visual uses no framework; this changes that for its look. Its two rules hold as they are: no script of the AI's runs in a visual, and nothing in it reaches the network. Only Rufi's own scripts run, by their hashes.

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

## Stored visuals

A reply is stored as written. Old visuals still draw, and their content stays readable: Preflight makes headings, lists and paragraphs with no style of their own plainer, every box measures `border-box`, and an `svg` is a block; text sized in `rem` grows by about a quarter. Before dogfood, Tailwind is upgraded freely. After it, upgrading Tailwind is a decision, since stored visuals keep its class names.

## Considered

- **A prebuilt CSS file of a fixed set of classes:** larger, and silent for any class outside it (above).
- **Compiling in the screens and sending the CSS with the visual:** each screen would carry the compiler, the iPhone's card page too; nothing smaller.
- **A CSS kit of Rufi's own:** the AI already knows Tailwind, and the screens use it.
- **Leaving Preflight out:** the AI writes Tailwind expecting it.
