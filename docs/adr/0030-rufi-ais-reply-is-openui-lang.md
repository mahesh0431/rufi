# 0030 · Rufi AI's reply is OpenUI Lang

**Date:** 1 Nov 2026 · **Status:** accepted · Supersedes [ADR 0029](0029-a-replys-trend-is-drawn-by-rufi-from-the-ais-block.md)'s trend block in a Markdown reply

Every reply of Rufi AI is OpenUI Lang, drawn by OpenUI's renderer in place of the Markdown renderer, as it is written. This follows OpenUI's recommended path for a chat UI of one's own: the agent writes OpenUI Lang, and "adding OpenUI changes a single component". Mahesh asked for OpenUI for the whole reply, so Rufi doesn't build its own kit, and for a page in a reply shown whole. Rufi's chat stays: Activity, receipts, the waiting list, the box and the dog. Notes, an agent's messages, receipts and visit briefs stay Markdown.

**The library is OpenUI's chat library, extended.** `openuiChatLibrary` from `@openuidev/react-ui` 0.18.1 (pinned, with `@openuidev/react-lang` 1.0.2), with `library.extend` (`apps/web/src/openui/library.ts`):

- **added:** Rufi's `Trend` and `TrendPoint`, `Page` and `Diagram`;
- **overridden** (same names and props): `TextContent`, `MarkDownRenderer`, `Callout`, `Steps` and `Card`, so every link opens by Rufi's rule, and `Image`.
  OpenUI's own parts are drawn as OpenUI draws them.

**The prompt is OpenUI's, from the same library.** `pnpm openui:md` writes `core/chat/openui.md` with `library.prompt(...)`, and a test checks the committed copy. Rufi AI gets it after its core instructions; an agent it starts doesn't, and writes Markdown. It is about 56 KB, given once per thread and cached.

- The options are the chat library's, with a Rufi preamble in place of OpenUI's default, and Rufi's rules added: values only from the record as it keeps them, a `Trend` for one test over time, pages and pictures as files in the AI's folder.
- OpenUI's chat rule "When asked about data, generate realistic/plausible data" is left out: Rufi never invents health data. The script stops if that rule is gone, so an OpenUI upgrade is checked.
- No inline or edit mode, and no tools: a reply is a whole program each time, with no `Query`, `Mutation` or bindings.
- OpenUI's CLI would write the same prompt, but it bundles with esbuild and sends telemetry. The library is written without JSX, so Node loads it directly.

**A finished reply draws only when it is whole.** OpenUI drops what it can't resolve or validate, sometimes without an error, and it doesn't check which part sits in a part's place (a `TextContent` where a `Table` takes a `Col` draws as an empty column), so a health value could vanish from the screen. Once a reply ended, it draws only when:

- OpenUI's parse is whole: nothing cut off, nothing unresolved or orphaned, no errors;
- and its tree fits the JSON schema OpenUI makes of the library, from its `Card` down: each part only where that part may go (anywhere in a place the schema leaves free, such as a table column's data), each part's props by its own schema wherever it sits, each prop by its type, nothing coerced. An expression, such as an action, is OpenUI's to read.
  Otherwise it shows its text, as written, with "This reply couldn't be drawn. Ask again to have it drawn." A reply with no OpenUI in it shows as Markdown, so a reply is never blank. Nothing else in a reply is checked.

**Styles follow OpenUI's Tailwind v4 recipe, without its ThemeProvider.** `styles.css` declares `@layer theme, base, openui, components, utilities;` and imports OpenUI's layered stylesheet. OpenUI's `ThemeProvider` writes colours into a `<style>` element, which the screens' CSP (`style-src 'self'`) refuses. The stylesheet itself holds OpenUI's light and dark tokens, chosen by `data-openui-theme` on the page, which `theme.js` sets with Rufi's theme before the first paint. OpenUI's chat components keep their own copy of its theme context, so a mode passed from outside wouldn't reach them anyway. Zod is set `jitless` as the screens' first import, before OpenUI builds its schemas, so the CSP refuses nothing.

**Actions as OpenUI says, with one difference.** A follow-up or a button (`continue_conversation`) sends its words as the person's message, with a form's values (`Form values:`, as OpenUI's guide to user actions writes them) and the context its action carries (`Context:`, which card or item was clicked, as OpenUI's own chat keeps it). An `open_url` opens as a link in a reply's text does: Rufi's own `rufi:/…` link opens the person's page in place, and a web address opens outside Rufi. Rufi's chat shows what was sent, so there's no separate display text. Sending empties the box, so when the person has typed something not yet sent, the click's words join the box after theirs, and they send them.

**Rufi's parts:**

- **Trend.** OpenUI's `LineChart` spaces its points evenly (`scalePoint`), smooths its line by default and draws a missing value at 0. So one test over time is Rufi's trend: spaced by date, the record page's drawing, with a table of every value and "Not drawn" for a value it can't place.
- **Page.** This is OpenUI's open-ended HTML pattern: one component, a sandboxed frame. It shows an HTML file from the AI's folder in the locked frame of ADR 0017, whole. The served page's appended script fits html and body to their content and tells the frame its height (`ui/notifications/size-changed`, as T3's `html_render` and MCP Apps do), and the frame takes it, from 80 to 20,000 px as T3 does, with nothing scrolling inside. A page made for a window (`min-height: 100vh`) would otherwise grow with the frame that fits it; the analysis skill's tips say to let content set the height.
- **Diagram.** Mermaid text, drawn in Rufi's diagram frame once the reply ended.
- **TextContent, MarkDownRenderer, Callout and Steps.** OpenUI's Markdown component, given Rufi's reply link parts through its `options`; `TextContent` keeps OpenUI's `[n]` citations of the Card's sources. OpenUI's Markdown component opens every link in a new tab, and OpenUI's `Callout` and `Steps` use it directly, so they are drawn as OpenUI draws them with Rufi's Markdown.
- **Card.** OpenUI's chat Card, whose sources and citations open by Rufi's rule: OpenUI's own call `window.open`. Their favicons aren't fetched; Rufi's screens load nothing from the web.
- **Other links OpenUI draws itself**, such as an `EditableTable`'s address cells, keep their raw address and stop their click. The reply catches such a click first (a capture handler) and opens it by the rule: a `rufi:/…` address in place; anything that isn't a web page or Rufi's own does nothing.
- **Image.** A picture file from the AI's folder by its path. Rufi's screens load no web pictures, so a web address shows as its words. A picture the AI generated shows once when the reply shows it, by `Image` or in its Markdown text.

**Display only.** No `toolProvider` and no tools in the prompt, so nothing in a reply reaches the record. Every string is text.

**Replies are kept as written.** Rufi's parts are frozen like a stored contract: they keep their names, the order of their props and their meanings, and a new prop goes only at the end. Replies written before this one are Markdown, and still show as Markdown.

**Considered:** OpenUI's `AgentInterface` (a second chat, where Rufi already has its own); inline mode (text with fenced blocks, which is ADR 0029's shape, and not the recommended path); `LineChart` for results over time (it misplaces dates); OpenUI Gateway or Autofix (a cloud service between Rufi and its providers). **Not now:** saving a form's values across reloads, OpenUI's artifacts panel, and a tuned type scale (OpenUI's text is its own size, a little larger than Rufi's chat text).
