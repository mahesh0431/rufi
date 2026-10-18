# Rufi's design

How Rufi looks, for the people and the agents who build its screens and pages. The values are in `tokens.css` beside this file; the dog is in `mark/`. The app (`apps/web`, and the desktop window around it) and the website read them from here, so a colour changes in one place.

The Rufi name and the dog, with everything in `mark/` (its code too), are not under the code's licence: see `TRADEMARKS.md` at the repository root. The tokens and this page are Apache 2.0 like the rest.

## Colour

Every colour comes from a token in `tokens.css`. Never write a colour value in a screen or a page; if no token fits, add one here first, with its job. In the app, Tailwind's own palette is off and lint refuses raw colours: the tokens are named for Tailwind in `apps/web/src/themes.css` (`bg-surface`, `text-ink`, …).

A theme is one block of values: light in `:root`, dark when `<html data-theme="dark">`, on screens only: paper is light, so a printed page keeps the light values in every theme. Each page sets `data-theme` before it paints, so it never shows the wrong theme first. The website is light only and never sets a theme.

| Token                               | Its job                                                              |
| ----------------------------------- | -------------------------------------------------------------------- |
| `--page`                            | The page behind everything                                           |
| `--side`                            | The sidebar, and soft fills: code, activity, hover                   |
| `--surface`                         | Groups, fields and floating panels on the page                       |
| `--line`                            | Borders and dividers                                                 |
| `--ink`                             | Text, headings too                                                   |
| `--muted`                           | Quieter text and icons                                               |
| `--accent`                          | The one main action on a screen, and selection marks; the focus ring |
| `--accent-hover`                    | The main action under the pointer                                    |
| `--on-accent`                       | Text and icons on the accent                                         |
| `--accent-soft`                     | What is selected, and the person's own messages                      |
| `--accent-ink`                      | Links and selected text                                              |
| `--danger`, `--danger-soft`         | Only the last step of a delete that can't be undone                  |
| `--paper`                           | Behind a page the AI made: white in every theme                      |
| `--edge`, `--shade`, `--shade-menu` | The hairline and the shadows around floating panels and menus        |

Rufi's own colours, for light pages (the website); they have no dark values and the app doesn't use them:

| Token                                | Its job                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `--body-text`                        | Running text on a reading page                                           |
| `--apricot`                          | The dog's folds; dots and lines                                          |
| `--apricot-text`                     | Accent words in a large heading (large text only: it is 3.9:1)           |
| `--apricot-icon` on `--apricot-tint` | An icon on a pale apricot square                                         |
| `--periwinkle`                       | The ground under the dog on a light page                                 |
| `--facet`                            | The faint paper facets behind the website's first screen                 |
| `--facet-deep`                       | The faint paper facets behind the website's first screen, the deeper one |

Rules:

- **Blue is for doing; apricot is Rufi.** The blue accent is for the main action and for what is selected, in the app and on the website. Apricot is only for Rufi itself: the dog's folds, and on the website the accent words in large headings, the dots and the pale icon squares. Never an apricot button.
- **No clinical colour.** No red, amber or green that could read as a health status (good, borderline, bad). A brand colour must never look like a result.
- **One red, for one job:** the last step of a delete that can't be undone. Nowhere else.
- **Calm greys, less black.** Pure ink is for the dog's dark ground only.
- **Contrast:** text keeps WCAG AA in every theme. Check a new pair before you use it.

## Type

Two font roles, as family stacks in the tokens; sizes and weights stay with each medium.

- `--font-ui`: the Mac's system font, for the app. The app is a 13 px desktop UI.
- `--font-brand`: Inter (variable), for the website. The website is a 16 px reading page; headings heavy (about 750–780) with tight letter spacing, body text regular.

## Icons

Lucide, everywhere (`lucide-react` in the app). One icon set, the same stroke; no second set beside it.

## Rufi paper

`paper.css` beside this file is one look the AI may give a page it makes; the analysis skill offers it beside the AI's own styles and plain Markdown. It is light on purpose, in every theme: a page reads as a sheet of white paper, as the frame behind it is (`--paper`), even when Rufi is dark. Its values are the light theme's. A page takes no outside files, so the AI puts the whole file in the page's `<style>`.

## The dog

Rufi is a dog folded from one sheet of white paper. The facets, the creases and the ear flaps make it look made with care, not a cartoon; keep the folded-paper language in everything new.

**Draw it only from the source.** `mark/rufi.js` is the one source: `svg(options)` returns a complete SVG, named "Rufi" for screen readers. Import it (`@rufi/brand/mark`), or use the generated files in `mark/assets/`. Never redraw, trace or copy the shapes into another file or project. To change the dog, change `rufi.js` once; every palette, size and expression follows.

```js
import { svg, live, follow } from "@rufi/brand/mark";
svg({
  palette: "inkApricot", // or "onApricot", "onPeriwinkle"
  expression: "calm", // see below
  size: 256, // 32 px and below draws the small, flat version
  ground: "tile", // "tile" (the app icon), "circle" (a badge) or "none"
  motion: false, // leave out for the expression's own motion
});
const rufi = live(svgElement, { expression: "calm" }); // the face moves: blinks, glances, follows the pointer
rufi.set("thinking"); // the eyes and the mouth change shape smoothly into the new expression
rufi.stop();
const stop = follow(svgElement); // or only the pointer: stop() ends it
```

Motion needs `@rufi/brand/mark/motion.css` on the page. Without `live()` the drawing still moves by CSS alone (blinks, ears, looks); `live()` adds the smooth changes between expressions and the pointer, with one animation frame per screen refresh, so use it for a large dog people look at (an empty page, the website), not for a small one in a list or the sidebar. Under reduced motion both keep it still. At 32 px and below the source draws the flat version by itself and hides the signs.

### Palettes

| Key            | Ground               | Use                                                                    |
| -------------- | -------------------- | ---------------------------------------------------------------------- |
| `inkApricot`   | ink `#1B2430`        | The main mark: the app icon, dark mode                                 |
| `onPeriwinkle` | periwinkle `#C9D0FF` | On a light page: the first choice (the app's light theme, the website) |
| `onApricot`    | apricot `#EE9A5B`    | On a light page: the second choice                                     |

- Rufi is always the white paper dog. Its folds are apricot (a deeper apricot on an apricot ground).
- On a dark ground it stands as it is. On a light page it sits on a colour: a tile, a badge or a panel, never straight on the page.
- On light grounds its face is a soft ink, so the mark doesn't look heavy.
- In the app the sidebar's dog is `onPeriwinkle` in the light theme and `inkApricot` in the dark one, following the theme, still.
- No stethoscope or other medical sign: Rufi keeps the record and prepares a person for the doctor; it is not the doctor.

### Expressions and motion

The face reacts to Rufi's own work, never to a person's health: no sad or alarmed face about a result. The face is slim pill eyes, a rounded triangle nose and a line mouth (a smile, a small smile, a grin, a flat line, a small frown): no open mouth or tongue. The eyes blink, soften, squeeze or look; the ears fold, lift and twitch. The default face is the smile.

| Key         | When                                                 |
| ----------- | ---------------------------------------------------- |
| `calm`      | The logo; idle (a blink, an ear twitch now and then) |
| `hello`     | First run, a new chat                                |
| `listening` | The person is speaking                               |
| `typing`    | The person is typing                                 |
| `thinking`  | The AI is working (three dots)                       |
| `reading`   | Reading a report the person added                    |
| `found`     | Found something: curious, not alarmed (a sparkle)    |
| `question`  | Rufi needs the person to decide (a ?)                |
| `done`      | A job is finished (a check)                          |
| `playful`   | A light moment; rarely                               |
| `tip`       | A hint (a small sparkle)                             |
| `steady`    | A serious topic: calm, the eyes a little down        |
| `sorry`     | Rufi could not do it                                 |
| `sleepy`    | About to pause                                       |
| `resting`   | Paused or offline (z z)                              |
| `alert`     | Something new came in                                |

- **Always respect reduced motion:** nothing moves and the eyes don't follow, also when the setting changes while the page is open (`motion.css` and `follow()` do this). The app's dog is always still.
- On the website the eyes follow the pointer only with a mouse or trackpad. A click on Rufi plays a laugh and a hop, with no sign.

### The generated files

`mark/assets/` holds the files to use without code, kept in git: every palette as a still SVG (mark, small mark, app tile, badge), the moving expressions on ink and on apricot, the app icon PNGs (1024 to 16 px), the Mac icon on the Mac's icon grid (`png/mac-icon-512.png`, the desktop app's Dock and bundle icon), the apricot tile PNGs and the favicons. Never edit them by hand: change the source, then

```sh
pnpm --filter @rufi/brand regenerate
```

It needs Playwright's Chromium (`pnpm exec playwright install chromium`); without it, it stops before it changes anything. `mark/preview.html` is a playground for palettes, expressions, grounds and motion: open it through a local server, because a browser won't load modules from a plain file.

## Tried and dropped

So nobody tries these again without a new reason:

- A stethoscope on or around the dog, in any form.
- A dark "ink dog" and monochrome versions.
- An apricot-paper dog standing on a light page: put the white dog on a colour instead.
- Ink (near-black) ear insides and faces on light grounds: too heavy.
- Triangle `^` eyes and zigzag `w` mouths.
- A flat cartoon dog head with ears stuck on, a full-body dog, and per-facet rounded corners (the folds look cut apart).
- A check mark sign when Rufi is clicked on the website.
- Ink main buttons: the blue accent stays the action colour.
- Warm cream backgrounds, and dark bands or a dark mode on the website.

## Later

- Name-and-mark lockups.
- Sharing weights, radius and shadow shapes between the app and the website, when a real need comes.
