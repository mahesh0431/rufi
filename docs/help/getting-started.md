# Getting started

Rufi runs on your Mac and opens in your browser, or as an app in its own window. Your records stay in your data folder on your Mac (see [Your data and the AI](your-data-and-the-ai.md)).

## Start Rufi

1. In the Rufi folder, run `pnpm start`. Rufi starts and opens a link in your browser. If the browser doesn't open, open the link that Rufi shows in the terminal. With `pnpm start --no-open`, Rufi only shows the link.
2. Keep the terminal open while you use Rufi. To stop Rufi, press Ctrl-C in that terminal.

The link works once, for 5 minutes. When the page opens, Rufi removes the link from the address bar. The tab stays open when you reload it.

## Open Rufi again

While Rufi runs, run `pnpm start` again in another terminal. It doesn't start a second Rufi: it opens a new link to the Rufi that runs. Use it to open Rufi in a new tab, or after you closed the tab.

If Rufi stops while a tab is open, the tab says "Rufi can't be reached" and keeps trying, in case Rufi was only busy. When you start Rufi again, use its new link: the old tab can't reach it.

If a tab says "This session has ended", the link was already used, or Rufi was started again. Run `pnpm start` to open Rufi again.

## Open Rufi as an app

1. In the Rufi folder, run `pnpm desktop`. A Rufi window opens, and Rufi is in the Dock. You don't need a link or a browser tab.
2. Keep the terminal open while you use Rufi.

- **⌘W** closes the window, and Rufi keeps running. To open the window again, click Rufi in the Dock.
- **⌘Q** quits the app and stops Rufi. If a reply is running, Rufi stops it first, as Stop does. Ctrl-C in the terminal does the same. If Rufi doesn't stop within 10 seconds, the app ends it at once, with anything the AI started.
- If you run `pnpm desktop` again while the app runs, the app comes to the front.
- If Rufi already runs from `pnpm start`, the app opens on that Rufi and doesn't start a second one. Then ⌘Q closes only the app: that Rufi keeps running until you press Ctrl-C in its terminal.
- A web link opens in your browser when you click it, or press Return on it.

If something goes wrong:

- If the app can't start Rufi, or the Rufi that the app started stops, or the window's page stops working, a message tells you what happened. Click Quit, then open the app again.
- If the app opened on the Rufi from `pnpm start` and that Rufi stops, the window says "Rufi can't be reached", as a tab does. Close the window with ⌘W, then click Rufi in the Dock: the app starts Rufi itself.
- If Rufi ended before it could stop a reply (it stopped by itself, or the app had to end it), the reply is marked interrupted the next time Rufi starts. What it wrote so far is kept.

## The first time

When nobody is in the data folder yet, Rufi asks "What's your name?" and adds you.

## What you see

- **The sidebar:** your name, then **Overview**, and at the bottom **Help** and **Settings**. When the AI can't be used, a line under them says why.
- **Overview:** your latest results, as the lab printed them: the test, the value and unit, the lab's range, the lab's note and when it was measured. "Amended" means that the lab corrected the result. When there are more results than Overview shows, it says so.
- **Settings:** your emergency region. When a message may describe an emergency, the AI gives this region's number; with no region, it says to call your local emergency number. See [What Rufi's AI will and won't do](safety.md#in-an-emergency-it-tells-you-to-call-for-help-first).
- **Help:** these pages.

The chat and the other pages come in later steps.

## If you're not signed in

The sidebar says "Not signed in" or "ChatGPT plan can't be used". Overview, Settings and Help still work; only the AI needs the sign-in. To sign in, stop Rufi and follow [how to sign in](signing-in.md#sign-in).
