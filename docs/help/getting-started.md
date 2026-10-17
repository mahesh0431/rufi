# Getting started

Rufi runs on your Mac and opens in your browser, or as an app in its own window. Your health record stays in your data folder on your Mac. The first time you start Rufi, it makes this folder, `~/.rufi/data`: you don't set anything up. If you used an earlier Rufi app, move its `~/.rufi` folder away (for example to `~/.rufi-old`) before you first start this Rufi: Rufi doesn't start, and changes nothing, while that folder holds the earlier app's files. To see the folder or move it, see [Your data and the AI](your-data-and-the-ai.md#where-your-data-lives).

## Start Rufi

1. In the Rufi folder, run `pnpm start`. Rufi starts and opens a link in your browser. If the browser doesn't open, open the link that Rufi shows in the terminal. With `pnpm start --no-open`, Rufi only shows the link.
2. Keep the terminal open while you use Rufi. To stop Rufi, press Ctrl-C in that terminal.

The link works once, for 5 minutes. When the page opens, Rufi removes the link from the address bar. The tab stays open when you reload it.

If the record is missing from a data folder that had one, Rufi doesn't start: it says so, and doesn't show an empty record in place of yours. See [Backups and export](backups-and-export.md#if-your-record-is-missing-or-empty). The same goes for a data folder that isn't there, for example on a disk that isn't connected: connect the disk and start Rufi again (see [Your data and the AI](your-data-and-the-ai.md#where-your-data-lives)).

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
- A web link opens in your browser, as it does when you use Rufi in a browser tab.

If something goes wrong:

- If the app can't start Rufi, or the Rufi that the app started stops, or the window's page stops working, a message tells you what happened. Click Quit, then open the app again.
- If the app opened on the Rufi from `pnpm start` and that Rufi stops, the window says "Rufi can't be reached", as a tab does. Close the window with ⌘W, then click Rufi in the Dock: the app starts Rufi itself.
- If Rufi ended before it could stop a reply (it stopped by itself, or the app had to end it), the reply is marked interrupted the next time Rufi starts. What it wrote so far is kept.

## Try Rufi with test data

To try Rufi without your own records, run `pnpm demo` in the Rufi folder. It opens the Rufi app, as `pnpm desktop` does, on its own demo folder, `~/Rufi-demo`. It never uses your data folder.

Each time you run it, the demo folder starts again with the same test data:

- A made-up family, Asha and Ravi Fictional, with their lab results, measurements (blood pressure and weight), medicines and an allergy.
- The first run is done, and the emergency region is India.
- A few days of Asha's chat with Rufi, with one change saved to her health record and its receipt.

Each time, everything that was in the demo folder is removed first: the record, its backups, the AI's earlier chats, and any file you put there yourself. Only the sign-in stays, so you sign in with ChatGPT once (see [Signing in with ChatGPT](signing-in.md#sign-in-in-rufi)), and the next demo is signed in.

`pnpm demo` doesn't start, and changes nothing, when:

- Rufi already runs on the demo folder. Quit that Rufi first.
- `RUFI_HOME` is set to another folder. Unset it first.
- `~/Rufi-demo` is a folder that `pnpm demo` didn't make, and it isn't empty. Move that folder away first.
- `~/Rufi-demo`, or a file or folder directly in it, is a link to somewhere else. Move it away first.

## The first time

In a new data folder, Rufi takes you through four short steps:

1. **Welcome.** Rufi says what goes to the AI: what you ask, the documents you add and the parts of your health record the AI reads go to the AI provider you sign in with. Your health record is kept on your Mac. Tick "I understand Rufi is not a doctor", then click **Continue**. Here you can also choose how Rufi looks: **System**, **Light** or **Dark** (see [How Rufi looks](#how-rufi-looks)).
2. **Your name.** Type it and click **Save and continue**. Rufi adds you to the record.
3. **Sign in with ChatGPT.** See [Signing in with ChatGPT](signing-in.md#sign-in-in-rufi). To do it later, click **Skip for now**: your health record works without the AI.
4. **Your emergency region,** for the number the AI gives in an emergency. Choose it and click **Save and continue**, or click **Skip for now**. You can change it in Settings.

The steps fill the window. Each step shows Rufi at the top, and small dots for where you are: a screen reader reads them as "Step 1 of 4" and so on. While your browser has ChatGPT's sign-in open, Rufi thinks. The welcome step also shows what goes where in two boxes: **Your Mac** keeps your health record; **The AI provider** gets what you ask, the documents you add and the parts the AI reads. The sidebar, Help, Settings and your chat show when the first run is done.

Rufi keeps each step you finished. If you reload the page, close it or open Rufi in another tab, you go on from the first step not done. Two tabs never add two people.

## What you see

- **The sidebar:** Rufi and your name, **Chat with Rufi**, **Overview**, **Health record** with each of its pages and its count (**Lab results**, **Measurements**, **Medicines** and the others), **Documents**, and at the bottom **Help** and **Settings**. When the AI can't be used, a line under them says why.
- **The chat bar:** the box at the bottom right of every page where you read your health (Overview, your health record's pages, Follow-ups and Documents), where you talk to Rufi. **Ask Rufi** on those pages puts things in it, and you stay on the page. It is your one chat with Rufi, the same as Chat with Rufi in the sidebar. See [Talking to Rufi](chat.md).
- **Overview:** what needs you (documents waiting to be saved or read again), your health record as one tile for each of its pages, and your recent changes. Each kind of record has its own page, and results have two: Lab results and Measurements. See [Your health record](record.md).
- **Settings:** the ChatGPT plan Rufi's AI uses (see [Signing in with ChatGPT](signing-in.md#your-plan-in-settings)), how Rufi looks, how a reply's Activity opens (see [Activity](chat.md#activity)), and your emergency region. When a message may describe an emergency, the AI gives this region's number; with no region, it says to call your local emergency number. See [What Rufi's AI will and won't do](safety.md#in-an-emergency-it-tells-you-to-call-for-help-first). Settings also holds the model and effort Rufi reads your documents with (see [Documents](documents.md#the-readers-model-and-effort)), shows your backups and exports your data (see [Backups and export](backups-and-export.md)), and shows where your data folder is (see [Your data and the AI](your-data-and-the-ai.md#where-your-data-lives)).
- **Help:** these pages.

The other pages come in later steps.

A page with nothing on it yet, such as Documents or Follow-ups in a new record, shows Rufi with the page's own words.

### Rufi's face

Rufi, at the top of the sidebar, shows what it is doing. When more than one thing is going on, the first line here that applies sets its face:

| When                                                                                              | Rufi              |
| ------------------------------------------------------------------------------------------------- | ----------------- |
| Rufi can't be reached, or the AI can't be used (you aren't signed in, or your plan can't be used) | Asleep (z z)      |
| Your last answer from the AI didn't finish, until you send again                                  | Sorry             |
| The AI chose a face in its last answer, until the next answer starts                              | The AI's choice   |
| A document is being read                                                                          | Reads             |
| The AI is working on an answer                                                                    | Thinks (dots)     |
| An answer or a reading just finished, for a few seconds                                           | Happy, with a hop |
| Your chat is new and empty                                                                        | Says hello        |
| Anything else                                                                                     | Calm              |

During a chat, the AI can choose Rufi's face for a moment of the conversation: asking you something, finding something worth a look, a tip, a light moment, or bringing up something new.

Rufi's face is about Rufi's own work and your conversation, never about your health results. When your Mac is set to reduce motion, Rufi doesn't move, but its face still changes.

## How Rufi looks

Rufi has a light look and a dark look. Choose one in **Settings** › **Appearance**, or on the welcome step:

- **System** (the start): Rufi follows your Mac's light or dark appearance, also when the Mac changes it.
- **Light** or **Dark:** Rufi stays so, whatever the Mac uses.

Your choice shows at once in the Rufi windows or tabs that are open in the same app or browser. A Rufi page open somewhere else, such as the Rufi app when you chose in your browser, shows it when you reload that page. Rufi keeps your choice when it starts again. In the Rufi app, the window around the page, with its sidebar, takes the same look.

## If you're not signed in

The sidebar says "Not signed in" or "ChatGPT plan can't be used". Overview, your chat, Settings and Help still work; only the AI needs the sign-in to answer. Click that line, or **Sign in** in **Settings** › **ChatGPT plan**, to sign in (see [Signing in with ChatGPT](signing-in.md#sign-in-in-rufi)).
