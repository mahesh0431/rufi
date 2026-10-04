# Getting started

Rufi runs on your Mac and opens in your browser. Your records stay in your data folder on your Mac (see [Your data and the AI](your-data-and-the-ai.md)).

## Start Rufi

1. In the Rufi folder, run `pnpm start`. Rufi starts and opens a link in your browser. If the browser doesn't open, open the link that Rufi shows in the terminal. With `pnpm start --no-open`, Rufi only shows the link.
2. Keep the terminal open while you use Rufi. To stop Rufi, press Ctrl-C in that terminal.

The link works once, for 5 minutes. When the page opens, Rufi removes the link from the address bar. The tab stays open when you reload it.

## Open Rufi again

While Rufi runs, run `pnpm start` again in another terminal. It doesn't start a second Rufi: it opens a new link to the Rufi that runs. Use it to open Rufi in a new tab, or after you closed the tab.

If Rufi stops while a tab is open, the tab says "Rufi can't be reached" and keeps trying, in case Rufi was only busy. When you start Rufi again, use its new link: the old tab can't reach it.

If a tab says "This session has ended", the link was already used, or Rufi was started again. Run `pnpm start` to open Rufi again.

## The first time

When nobody is in the data folder yet, Rufi asks "What's your name?" and adds you.

## What you see

- **The sidebar:** your name, then **Overview**, and at the bottom **Help** and **Settings**. Under them, whether Rufi can use your ChatGPT plan.
- **Overview:** your latest results, as the lab printed them: the test, the value and unit, the lab's range, the lab's note and when it was measured. "Amended" means that the lab corrected the result. When there are more results than Overview shows, it says so.
- **Emergency:** the button at the top of every page. See [Emergency](emergency.md).
- **Help:** these pages.

The chat and the other pages come in later steps.

## If you're not signed in

The sidebar says "Not signed in" or "ChatGPT plan can't be used". Overview, Help and Emergency still work; only the AI needs the sign-in. To sign in, stop Rufi and follow [how to sign in](signing-in.md#sign-in).
