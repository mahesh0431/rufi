# Documents

You can add lab reports and other documents to Rufi as PDFs or photos. Rufi keeps each original exactly as it came, so you can always look at it again, and reads each document in the background, so you don't have to type its results. This page says how to add documents, how Rufi reads them, and how to look at an original.

You can also ask the AI about a document in the chat, and it looks at the pages it needs (see [Your data and the AI](your-data-and-the-ai.md#the-pages-the-ai-looks-at)).

## Add documents

1. In the sidebar, click **Documents**.
2. Click **Add documents** and choose one or more files. You can also drop files on the page.

Rufi takes PDFs and photos in JPEG, PNG or HEIC (the format of iPhone photos). It knows a file by its content, not by its name.

### Photos taken together

When you choose two or more photos at once, Rufi first shows them in a list, with **3 photos → one document**. This is for one report that you photographed page by page: the photos become the pages of one document.

- To change the order of the pages, drag a photo to its place. With the keyboard, go to a photo's handle and press the Up or Down arrow.
- To make each photo a document of its own, turn the switch off.
- Click **Add … documents** to add them, or **Cancel** to add nothing.

A PDF is always a document of its own, also when you add it together with photos.

### The same file again

Rufi adds each file only once for a person. When a file has the same content as a document you already added, Rufi says **was already added** and links to that document; nothing new is added. It looks at the content, so a copy with another name is found too. Two files with the same name but different content are two documents.

### When Rufi doesn't add a file

If one of the files isn't a PDF, JPEG, PNG or HEIC photo, is damaged, or is a PDF protected with a password, Rufi says which file and why, and adds none of the files you chose. Remove that file and add the others again. For a PDF with a password, save a copy without the password and add that.

## Your documents

The Documents page lists everything you added, newest first:

| Column   | What it shows                                                             |
| -------- | ------------------------------------------------------------------------- |
| Document | The file's name as you added it, and its pages or how many more photos    |
| Kind     | A lab report, prescription, letter or other; empty until Rufi reads it    |
| Date     | The document's date; empty until Rufi reads it                            |
| Added    | The day you added it                                                      |
| Status   | How its reading went (see below), with **Read it**, **Retry** or **Open** |

To show one kind only, choose it in the list at the top left.

| Status              | What it means                                                            |
| ------------------- | ------------------------------------------------------------------------ |
| **Not read yet**    | Rufi hasn't read it: it waits for your yes, or for **Read it**           |
| **Reading**         | Rufi reads it now, or it waits its turn; it shows the pages saved so far |
| **To check**        | Read: its results wait for you to check and save them                    |
| **Nothing to save** | Read, and no results were found (a letter, for example)                  |
| **Failed**          | The reading stopped before the end; **Retry** continues it               |

## How Rufi reads a document

Rufi's reader is an AI that reads one document at a time, page by page, in the background. It copies what each page says: every result exactly as printed (`<5` stays `<5`), with its unit, range and the lab's own flag, and the dates, lab and name printed on the page. It doesn't judge your results and it saves nothing to your record. It sees only that document's pages: not your record, your chat, other documents or the internet.

### Your yes, once

Before the reader reads anything, Rufi asks once: **Read … with the AI?** It sends a document's pages to the AI you signed in with (your ChatGPT plan) to read them. The question shows above the chat box and on the Documents page.

- **Read it**: Rufi reads the documents that wait, and every document you add after this.
- **Not now**: nothing is sent. Your documents show **Not read yet**; click **Read it** next to one to be asked again.

To change your answer later, go to **Settings** → **Documents** → **Read documents with the AI**. Off: nothing new is read; a reading that runs finishes. On again: the documents that waited keep their own **Read it**.

### While a document is read

- A line in the chat says the reading started: **Reading thyrocare-aug.pdf · 5 pages**.
- Above the chat box, the reader strip shows each reading: the one at work with its pages saved and time (**saved 3 of 5 · 1 min**), and those that wait their turn (**waiting**). You can keep chatting meanwhile.
- Click **Open ▸** to see the reader's work as it goes: each page it saved, with the facts and results it read, its one note for the whole document, Rufi's checks (below) and how much of your plan it used. **Open** shows only; you check and fix results in a later step.

### When the reading ends

The strip item goes, and a line in the chat says what was read, for example **Lab report · 12 Aug · 42 results read · 1 to check · Open**. A document with reports of several dates says so: **6 reports · 4 dates**.

When something needs you, the AI asks about it in the chat, in a few lines: a value marked unsure, a page that couldn't be read, another name on the report, an unclear date. It only reads and asks; it never saves on its own.

The results are kept as **draft items**: they wait for you and stay across restarts, but they aren't part of your record yet, so they don't count in your Overview or the AI's answers. Saving them from the chat comes in a later version of Rufi.

### What the marks mean

Rufi checks each page the reader saves. A check never changes what the reader read; it marks it, so you look at it:

| Mark                  | Why                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| **unsure**            | The reader wasn't sure, a number doesn't match the value as printed, or a value isn't in the PDF's own text |
| **may be incomplete** | The reader counted more (or fewer) rows on the page than it saved                                           |
| **couldn't be read**  | The reader couldn't read the page, and says why                                                             |
| **not looked at**     | The reading ended without this page                                                                         |

## When a reading stops

- **Rufi closed while reading:** when Rufi starts again, the reading continues where it stopped (**reading again** in the strip), with the pages it already saved. You see one start line and one end line.
- **You're signed out:** the reading waits (**waiting for sign-in**) and goes on when you sign in.
- **Your plan's usage limit:** the reading waits until the limit resets (**waiting until 14:30**), then goes on.
- **The AI connection was lost or restarted:** Rufi tries once more by itself.
- **It took too long, or failed again:** the line says **Couldn't finish reading … · saved 3 of 5**, with **Retry**. The pages saved so far are kept, and no results are made until a reading finishes.

**Retry** (on the line, in **Open**, or on the Documents page) continues a reading that failed. For a document that was read with pages that couldn't be read or weren't looked at, it reads only those pages again; the results already read, and any you changed, stay as they are. You can also ask the AI in the chat to read a document again.

## Look at an original

Click a document's name. Rufi opens the original over the page:

- A PDF opens in the built-in PDF viewer, where you can go through its pages and zoom.
- Photos show one under the other, in the order of the pages. A HEIC photo shows through a JPEG copy that Rufi made when you added it; if that copy is missing, Rufi makes it again and says **Preparing the photo…** meanwhile.

A link inside a PDF doesn't open: Rufi's window always stays in Rufi.

To close it, click **×** or press Esc. While you work in a PDF, Esc goes to the PDF viewer; click **×** instead.

In a browser that has no PDF viewer, Rufi says so and offers **Save a copy**, to open the PDF on your Mac.

## Where your documents are kept

The originals are in the `files` folder in your data folder, each named by its content's fingerprint (its SHA-256 hash). Rufi writes each file to disk completely before the document shows in Rufi. Your backups and the export hold every original (see [Backups and export](backups-and-export.md)).

You can't delete a document yet.
