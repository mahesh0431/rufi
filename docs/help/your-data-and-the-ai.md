# Your data and the AI

Rufi keeps your health record on your Mac. This page says where it is, how to move it, what the AI sends, what Rufi keeps of your chat, and what Rufi writes in its log.

## Where your data lives

Everything for your health record is in one data folder on your Mac. The first time you start Rufi, it makes this folder for you, in Rufi's home folder `~/.rufi`. You don't set anything up:

```
~/.rufi/data
```

To see where your data folder is, open **Settings** › **Data folder**. **Show in Finder** shows it in Finder. Finder hides folders whose name starts with a dot, such as `~/.rufi`: **Show in Finder** opens it anyway, and in Finder ⇧⌘. (Shift-Command-period) shows hidden folders.

Rufi remembers where your data folder is in a small file, the location file: `~/.rufi/location.json`. It holds only the folder's path, never health data or secrets. Each time Rufi starts, it opens that folder:

- If the folder isn't there (for example, it is on a disk that isn't connected, or it was deleted), Rufi says so and doesn't start. It never starts an empty record in place of yours. Connect the disk, or put the folder back, and start Rufi again.
- If the folder is there but your record isn't in it (for example, an empty folder where the disk used to be), Rufi doesn't start either. Check that it is the right disk.
- If the location file is damaged, Rufi doesn't start. Get the file back from your Mac's backup, or put your data folder's path back in it: `{"version": 1, "dataFolder": "/path/to/your/data/folder"}`.
- If the location file is gone and `~/.rufi/data` holds your record, Rufi remembers that folder again and starts. If that folder holds other files but no record, Rufi doesn't start and changes nothing.
- If there is no location file and `~/.rufi` holds files from an earlier Rufi app, Rufi doesn't start and changes nothing there. Move that folder away (for example to `~/.rufi-old`), then start Rufi again.

> **Note:** If you delete both the location file and your data folder, Rufi can't tell that from a new Mac: it starts a new, empty record. To get your data back, restore a backup (see [Backups and export](backups-and-export.md#restore-a-backup)).

Keep the data folder on your Mac's own disk or on a disk that you connect to your Mac. Don't put it in iCloud Drive, Dropbox or another folder that syncs to the cloud, or on a network disk: their copies can damage your record. Rufi doesn't move it there (see [Move your data](#move-your-data)). A copy of a backup or of an export can go anywhere.

Your sign-in's secrets aren't in the data folder: they are in your Mac's Keychain (see [Signing in with ChatGPT](signing-in.md)).

| In the data folder | What it is                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rufi.sqlite`      | Your health record (people, documents, reports, lab results and measurements) and your chat, with what the AI did in it (see below)                                                                                                                                                                                                                                                                    |
| `agents.sqlite`    | The AI's working state: the agents that run your chat, and what the AI did for each reply (its **Activity**). It isn't in your backups or your export; when it's missing, Rufi makes a new one, a reply that was running shows as stopped, the AI starts a new thread with your chat's last messages, replies since this version say their Activity is gone, and your chat and record stay as they are |
| `files/`           | Your documents, exactly as you added them (see [Documents](documents.md))                                                                                                                                                                                                                                                                                                                              |
| `backups/`         | Rufi's backups of your record and your documents (see [Backups and export](backups-and-export.md))                                                                                                                                                                                                                                                                                                     |
| `cache/`           | Copies Rufi makes again when they are missing: the JPEG copy that shows a HEIC photo, and the pages of your PDFs drawn as images for the AI                                                                                                                                                                                                                                                            |
| `chatgpt.json`     | Your sign-in details, without secrets (see [Signing in with ChatGPT](signing-in.md))                                                                                                                                                                                                                                                                                                                   |
| `logs/`            | Rufi's log (see below)                                                                                                                                                                                                                                                                                                                                                                                 |
| `codex/`           | The AI's own files: its settings, Rufi's instructions for the AI, its own copy of your chat, and the pictures it generates                                                                                                                                                                                                                                                                             |
| `ai/`              | The AI's folder: where the AI works, with its programs, notes and research files (see [What the AI can do in its folder](#what-the-ai-can-do-in-its-folder))                                                                                                                                                                                                                                           |
| `sub-agents/`      | The settings of Rufi's document reader; it holds no document                                                                                                                                                                                                                                                                                                                                           |

Rufi also keeps a few small files there that say what state the folder is in: while Rufi runs, and while a first start, a move or a restore isn't finished. With them, Rufi never opens a folder that another Rufi uses, or one that is only half made.

When Rufi creates your data folder, it makes it private to your Mac user account. The files Rufi writes in it, such as `rufi.sqlite` and the log, are private to your account too. Rufi doesn't change a folder that already existed, so who can open a folder you chose depends on that folder's permissions and on who can use your Mac account.

## Move your data

You can move your data folder to another folder: on your Mac, or on a disk that you connect to it.

1. Quit Rufi: **⌘Q** in the Rufi app, or Ctrl-C in the terminal where `pnpm start` runs. To close the window isn't enough.
2. In the Rufi folder, run `pnpm rufi move-data` with the new folder. The new folder must not exist yet, or must be empty. For example:

   ```
   pnpm rufi move-data /Volumes/Health/Rufi
   ```

3. Start Rufi as usual. It opens on the new folder.

Rufi copies everything in your data folder into the new folder: your health record and your chat, your documents, your backups and your sign-in. It checks the copy (the record, and each file against the old one) and only then uses the new folder. You stay signed in.

The AI's own files (`codex/` and `sub-agents/`) and the AI's folder (`ai/`) stay in the old folder, because they name the old folder. Your chat is in your record, so nothing of it is lost: your next message starts a new thread for the AI with the chat's last messages, and the chat shows "New thread started" there. The AI's programs and notes stay in the old folder's `ai/`; copy what you want to keep.

The old folder stays as it was, with a `moved-to.json` file that names the new folder. Rufi doesn't open the old folder any more, also not with `RUFI_HOME`, so that you never change two copies. Delete it when you're ready.

Rufi doesn't move your data, and changes nothing, when:

- Rufi or a Rufi command runs. Quit it first.
- The new folder isn't empty, is your data folder, is in it, or holds it. Choose a new folder.
- The new folder is in iCloud Drive or in a cloud folder in `~/Library/CloudStorage` (such as Dropbox, Google Drive or OneDrive), or on a network disk. Rufi can't find every folder that syncs: also don't use Desktop or Documents when iCloud keeps them.
- `RUFI_HOME` is set. Unset it first.

If the copy fails (for example, the disk is full, or the data folder holds a link that Rufi can't copy), Rufi says why and keeps your old folder. The new folder keeps what was copied, marked so that Rufi never opens it. Delete it before you try again.

### If a move stopped

If a move stopped before it finished (for example, the Mac turned off), Rufi doesn't start: it says that the move didn't finish. Then run one of these:

- `pnpm rufi move-data --finish`: Rufi checks the copy again, and finishes the move. If the copy isn't complete, Rufi says so and changes nothing.
- `pnpm rufi move-data --cancel`: Rufi goes back to the old folder. It marks the new folder as cancelled, so that it never opens it, and keeps all its files. Delete the new folder when you're ready.

If the new folder is on a disk that isn't connected, connect it first. Rufi must mark that copy as cancelled before it can use the old folder again. If it can't write that mark, it keeps the move open and says why.

When a move is finished, there is nothing to finish or cancel. To go back, move your data again, into a new folder.

## Start Rufi on another folder

`RUFI_HOME` starts Rufi on another data folder for one run, for example on a restored copy (see [Backups and export](backups-and-export.md#restore-a-backup)):

```
RUFI_HOME=~/Rufi-restored pnpm start
```

Then Rufi doesn't read or change the location file, and **Settings** › **Data folder** says that `RUFI_HOME` chose the folder. The next time you start Rufi without it, Rufi opens your usual data folder.

## What goes to the AI

> **Note:** When you ask Rufi something, the AI reads the parts of your health record it needs. That text goes to the AI service you signed in with (today OpenAI, through your ChatGPT plan) so it can answer. See [OpenAI's policies](https://openai.com/policies/) for how they handle it.

When the AI reads your record with Rufi's tools, it gets only the records of the person whose chat it is: Rufi chooses the person, and the AI can't name another one. The AI can't read the chat or Rufi's settings this way, and it can't change anything. It doesn't read your [device data](device-data.md) yet.

Rufi's tools aren't all that the chat's AI can do: it also works in its own folder (see below). The [reader](#reading-your-documents) is different: Rufi locks it to two tools for one document.

## What the AI can do in its folder

The chat's AI works like a coding agent, in its own folder: the AI's folder, `ai/` in your data folder. There it can write and run small programs, for example to compare two kinds of results, and keep its notes and research files between messages and days. It can use the internet from there, for example to look something up or to install what a program needs. Settings says this too.

Rufi limits what the AI's programs can reach. This is a lock, not only an instruction: Codex's sandbox on your Mac holds it.

- They can write only in the AI's folder and in your Mac's folders for temporary files.
- They can't open your record's database, the AI's working state (`agents.sqlite`) or your backups. So the AI reads and changes your health record only through Rufi's tools: each read shows as a step in the answer's **Activity**, and each save with its receipt.
- They get none of the sign-in's secrets.
- They can read the other files that your Mac account can read. Rufi tells the AI to use only Rufi's tools for your record, but it doesn't lock the rest yet.

Rufi doesn't check what the AI sends to the internet or gets from it. Text from a web page is data for the AI, never an instruction or your yes.

When the AI makes a picture or a page to show you, the reply shows it from the AI's folder, or from `codex/generated_images/` for a picture the AI generated. Rufi shows nothing from anywhere else. See [Pictures, pages and diagrams](chat.md#pictures-pages-and-diagrams).

The AI's folder isn't part of your health record. What you want to keep goes in your record, through the chat, after your yes. The folder isn't in your backups, your export or a move yet.

The AI keeps its working notes in `ai/work/`, a folder for each day: for example its copy of a document's pages while it reads them. At each start and once a day, Rufi removes the days older than 3. When you delete a document, Rufi also removes the AI's working notes on it; other files the AI made from it stay.

## The pages the AI looks at

When you ask about a document in the chat, the AI can look at its pages, one at a time, the way you would:

- **A PDF page:** Rufi draws the page as an image and gives it with the page's own text, when the PDF has text (a scanned PDF has none). Links and anything else in the PDF that would act on its own are left out.
- **A photo:** the photo as you added it. A HEIC photo goes as its JPEG copy, because the AI can't open HEIC.

Each page the AI looks at goes to the AI service you signed in with, like the parts of your record it reads. Rufi's tool gives the AI only the documents of the person whose chat it is. Looking at a page changes nothing; documents aren't part of your record until you save from them.

Rufi draws a page again when it needs it; the drawn pages aren't in your backups or your export.

## Reading your documents

Rufi reads each document you send with its own reader, when you send it (see [Documents](documents.md#how-rufi-reads-a-document)). A file you add goes nowhere until you send the message: it waits in the box, on your Mac. Nothing goes to any other service, and when the AI can't be reached, Rufi doesn't fall back to another one: the reading waits or fails, and says so.

The reader sends the document's pages to the AI service you signed in with, the same way as above. It is a separate AI that Rufi starts for that one document:

- It gets Rufi's instructions for copying pages, the file's name and the list of its pages. It doesn't get whose document it is, your chat or your record.
- It can do two things only, both through Rufi: look at a page of that document, and save its copy of the page. It has no files, no commands and no internet, and it can't start other work. This is a lock, not only an instruction: Rufi starts the reader without them, and stops a reading that uses anything else.
- Rufi keeps the reader's copy of each page in `rufi.sqlite`, with how much of your plan the reading used. The reader's own record of its work isn't kept. Pages an older Rufi read keep what its reader saved then (its notebook).

When the reading ends, Rufi gives the page copies to Rufi AI, the AI you chat with, with your message, in the same reply. Rufi AI sorts the file into documents and drafts their results, then answers you (see [Documents](documents.md#how-rufi-ai-sorts-a-file)). Rufi AI reads the copies with Rufi's tools, as it reads your record, and saves nothing to your record without your yes. What it did shows in **Activity**, like any reply. Rufi starts no reply of its own to sort a file.

Draft items aren't your record until you save them. They are in your backups and your export (the `draft_items` table), apart from your record, with the page copies (`page_copies`).

## Your chat

Rufi keeps your chat in `rufi.sqlite`: your messages, the AI's replies, the questions the AI asks you, and a receipt for each save to your record. What you see is what Rufi saved.

What the AI did for each reply, which you see in **Activity**, is kept in the AI's working state, `agents.sqlite`:

- One line for each thing the AI did, such as reading your record or searching the web, with what it sent and got back, as the AI service gave it: for example a read of your records, a command and its output, or the words of a web search. You see it when you open a step.
- The AI's notes, and its reasoning summaries when the AI service gives them. You see the summaries behind each thinking line.

`agents.sqlite` isn't in your backups or your export. If it's lost, those replies say **Activity is gone with the AI's working state.**, and what their sub-agents did is gone too. Replies from before this version of Rufi keep their Activity in `rufi.sqlite`.

So that an answer can be traced later, Rufi also keeps, as long as the chat:

- For each read or save with Rufi's own tools, exactly what Rufi answered, except the page images the AI looked at: Rufi keeps which page it was, not the image. This isn't shown.
- For each change to your record, the record before and after it, and the message of yours it came from.
- What you typed in the chat but didn't send (the chat's draft). Drafts stay on your Mac until you send them.

What a sub-agent does is kept in `agents.sqlite` like the AI's own steps, apart from your chat; what one saves to your record has its receipt in the chat. The AI's own copies in `codex/` hold more, as long as the AI keeps them, also the page images the AI looked at.

## What Rufi logs

Rufi writes its own log to `logs/rufi.log` in the data folder, to help find problems: what happened and when, such as which of Rufi's tools ran, statuses, error codes and timings.

The log never holds your words, the AI's replies, health text or your sign-in. It stays on your Mac, and Rufi removes its oldest lines as it grows. With `--debug`, `pnpm rufi ask` also shows these lines in the terminal.

The AI's own files in `codex/` are separate from this log.
