# Your data and the AI

Rufi keeps your records on your Mac. This page says where they are, what the AI sends, what Rufi keeps of your chat, and what Rufi writes in its log.

## Where your data lives

Everything is in one data folder on your Mac. Today you choose it with the `RUFI_HOME` setting before you run Rufi.

| In the data folder | What it is                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rufi.sqlite`      | The record (people, documents, reports and results) and your chat, with what the AI did in it (see below)                                                                                                           |
| `installed.json`   | Says a record was made in this folder. If it is there and `rufi.sqlite` isn't, Rufi doesn't start: it never shows an empty record in place of yours                                                                 |
| `files/`           | Your documents, exactly as you added them (see [Documents](documents.md))                                                                                                                                           |
| `cache/`           | Copies Rufi makes again when they are missing: the JPEG copy that shows a HEIC photo, and the pages of your PDFs drawn as images for the AI (see below)                                                             |
| `backups/`         | Rufi's backups of `rufi.sqlite` and your documents, made when it starts and then each day. They never hold your sign-in, the AI's files, the log or `models.json` (see [Backups and export](backups-and-export.md)) |
| `chatgpt.json`     | Your sign-in details, without secrets (see [Signing in with ChatGPT](signing-in.md))                                                                                                                                |
| `models.json`      | The AI models Rufi may use, in the order Rufi shows them; the chat uses the first one until you choose another. It starts with the strongest ones, and you can edit the list                                        |
| `logs/`            | Rufi's log (see below)                                                                                                                                                                                              |
| `codex/`           | The AI's own files: its settings, its own copy of your chat with what its tools returned, and the messages that wait for the AI                                                                                     |
| `workspace/`       | The folder where the AI works                                                                                                                                                                                       |
| `sub-agents/`      | The settings and the empty working folder of Rufi's document reader (see below); it holds no document                                                                                                               |
| `core.json`        | There while Rufi runs: how `pnpm start` finds the running Rufi to open it again. Rufi removes it when it stops                                                                                                      |
| `rufi.lock`        | A folder that is there while Rufi or a Rufi command uses the data folder, so only one of them does at a time                                                                                                        |
| `credentials.lock` | A short-lived folder while Rufi changes or renews the sign-in                                                                                                                                                       |
| `restoring/`       | There only when a restore into this folder didn't finish. Rufi doesn't start on such a folder                                                                                                                       |

When Rufi creates your data folder, it makes it private to your Mac user account. The files Rufi writes in it, such as `rufi.sqlite` and the log, are private to your account too. Rufi doesn't change a folder that already existed, so who can open a folder you chose depends on that folder's permissions and on who can use your Mac account.

> **Note:** When you ask Rufi something, the AI reads the parts of your record it needs. That text goes to the AI service you signed in with (today OpenAI, through your ChatGPT plan) so it can answer. See [OpenAI's policies](https://openai.com/policies/) for how they handle it.

When the AI reads your record with Rufi's tools, it gets only the records of the person whose chat it is: Rufi chooses the person, and the AI can't name another one. The AI can't read the chat or Rufi's settings this way, and it can't change anything.

Rufi's tools aren't all that the chat's AI can do. It runs with the same access to this Mac as Codex has when you use it yourself: it can run commands and open the files your Mac account can open. Rufi tells it to use only Rufi's tools for your record, but that is an instruction, not a lock. Treat the chat as able to see your data folder. The [reader](#reading-your-documents) is different: Rufi locks it to two tools for one document.

## The pages the AI looks at

When you ask about a document in the chat, the AI can look at its pages, one at a time, the way you would:

- **A PDF page:** Rufi draws the page as an image and gives it with the page's own text, when the PDF has text (a scanned PDF has none). Links and anything else in the PDF that would act on its own are left out.
- **A photo:** the photo as you added it. A HEIC photo goes as its JPEG copy, because the AI can't open HEIC.

Each page the AI looks at goes to the AI service you signed in with, like the parts of your record it reads. Rufi's tool gives the AI only the documents of the person whose chat it is. Looking at a page changes nothing; documents aren't part of your record until you save from them.

Rufi keeps the drawn PDF pages in `cache/` and draws a page again when its copy is missing; they aren't in your backups or your export.

## Reading your documents

Rufi reads each document you add with its own reader, as soon as you add it (see [Documents](documents.md#how-rufi-reads-a-document)). Nothing goes to any other service, and when the AI can't be reached, Rufi doesn't fall back to another one: the reading waits or fails, and says so.

The reader sends the document's pages to the AI service you signed in with, the same way as above. It is a separate AI that Rufi starts for that one document:

- It gets only Rufi's instructions for reading, the list of the document's pages and its own notes: none of your chat or your record.
- It can do two things only, both through Rufi: look at a page of that document, and save what the page says in its notebook. It has no files, no commands and no internet, and it can't start other work. This is a lock, not only an instruction: Rufi starts the reader without them, and stops a reading that uses anything else.
- Its thread isn't saved by the AI. Rufi keeps its notebook (what each page says) and its draft items in `rufi.sqlite`, with the reader's version and how much of your plan the reading used.

Draft items aren't your record until you save them. They are in your backups and your export (the `draft_items` table), apart from your record.

## Your chat

Rufi keeps your chat in `rufi.sqlite`: your messages, the AI's replies, one line for each thing the AI did, such as reading your record or searching the web, and a receipt for each save to your record. Rufi saves each part before it shows it, so what you see is what was saved.

Rufi also keeps everything the AI did in a reply, so that an answer can be traced later:

- For each thing the AI did, everything it sent and got back, as the AI service gave it: for example a read of your records and what it got back, a command and its output, or the words of a web search.
- For each read or save with Rufi's own tools, what the AI asked and exactly what Rufi answered, except the page images it looked at: Rufi keeps which page it was, not the image.
- The AI's reasoning summaries: a short account of its thinking, when the AI service gives one. Rufi asks for them.

You don't see these in Rufi yet, except as **Based on** under each answer. Rufi keeps them as long as the chat. Work the AI gives to a sub-agent isn't kept.

For each change to your record, Rufi also keeps the record before and after it, and the message of yours it came from.

It also keeps what you typed in the chat but didn't send (the chat's draft). Drafts stay on your Mac until you send them.

The AI's own copies in `codex/` hold more, as long as the AI keeps them, also the page images the AI looked at.

## What Rufi logs

Rufi writes its own log to `logs/rufi.log` in the data folder, to help find problems. Each line is a fixed event with checked details: the event's name, the names of the AI's messages and of Rufi's tools, statuses, error codes and timings.

The log never holds your words, the AI's replies, health text or your sign-in. It stays on your Mac. At 10 MB Rufi starts a new file, and it keeps five files at most.

With `--debug`, `pnpm rufi ask` also shows these same lines in the terminal.

This is about `logs/rufi.log` and its older copies only. The AI's own files in `codex/` are separate.
