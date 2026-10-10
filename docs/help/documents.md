# Documents

You can add lab reports and other documents to Rufi as PDFs or photos. Rufi keeps each original exactly as it came, so you can always look at it again, and reads each document in the background, so you don't have to type its results. This page says how to add documents, how Rufi reads them, how to check what it read, how to save the results to your record, and how to look at an original.

You can also ask the AI about a document in the chat, and it looks at the pages it needs (see [Your data and the AI](your-data-and-the-ai.md#the-pages-the-ai-looks-at)).

## Add documents

1. In the sidebar, click **Documents**.
2. Click **Add documents** and choose one or more files. You can also drop files on the page.

Rufi takes PDFs and photos in JPEG, PNG or HEIC (the format of iPhone photos). It knows a file by its content, not by its name.

You can also add documents in the chat: click the paperclip next to the box, or drop files on the chat. They are added the same way, and each one's chip goes in the box (see [Adding to a message](chat.md#adding-to-a-message)). To add a document you already have to a message, point at its row on the Documents page and click **+ Add to chat**.

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

| Column   | What it shows                                                          |
| -------- | ---------------------------------------------------------------------- |
| Document | The file's name as you added it, and its pages or how many more photos |
| Kind     | A lab report, prescription, letter or other; empty until Rufi reads it |
| Date     | The document's date; empty until Rufi reads it                         |
| Added    | The day you added it                                                   |
| Status   | How its reading went (see below), with **Retry** or **Open**           |

To show one kind only, choose it in the list at the top left.

| Status              | What it means                                                            |
| ------------------- | ------------------------------------------------------------------------ |
| **Not read yet**    | Never read (added before Rufi read each document); **Retry** reads it    |
| **Reading**         | Rufi reads it now, or it waits its turn; it shows the pages saved so far |
| **To check**        | Results wait for you to check, or a page needs **Retry**                 |
| **Nothing to save** | Read, and no results were found (a letter, for example)                  |
| **Failed**          | The reading stopped before the end; **Retry** continues it               |

## How Rufi reads a document

Rufi's reader is an AI that reads one document at a time, page by page, in the background. It copies what each page says: every result exactly as printed (`<5` stays `<5`), with its unit, range and the lab's own flag, and the dates, lab and name printed on the page. It doesn't judge your results and it saves nothing to your record. It sees only that document's pages: not your record, your chat, other documents or the internet.

Rufi reads each document as soon as you add it. It sends the document's pages to the AI you signed in with (your ChatGPT plan) to read them. The first run tells you this once.

### The reader's model and effort

In **Settings** → **Documents**, choose the **Reader model**: **GPT-6.1-Sol** (the start) or **GPT-5.5**. These are the models where Rufi can lock the reader down to its two tools. On GPT-6.1-Sol, the reader uses its tools through small pieces of code, with no files and no internet (see [Your data and the AI](your-data-and-the-ai.md#reading-your-documents)).

Then choose its **Effort**: **Low**, **Medium** (the start) or **High**. Higher effort thinks longer on each page, and uses more of your plan.

Your choice is used by the next reading that starts. A reading that runs keeps the model and effort it started with; if it stops and goes on later (after Rufi restarts, or with **Retry**), it goes on with the ones chosen then.

### While a document is read

- A line in the chat says the reading started: **Reading thyrocare-aug.pdf · 5 pages**.
- Above the chat box, the reader strip shows each reading: the one at work with its pages saved and time (**saved 3 of 5 · 1 min**), and those that wait their turn (**waiting**). You can keep chatting meanwhile.
- Click **Open ▸** to see the reader's work as it goes: each page it saved, with the facts and results it read, its one note for the whole document, Rufi's checks (below) and how much of your plan it used. **Open** shows only; you check and fix results on the document's page (see [Check a report](#check-a-report)).

### When the reading ends

The strip item goes, and a line in the chat says what was read, for example **Lab report · 12 Aug · 42 results read · 1 to check · Open**. **Open** goes to the document's page. A document with reports of several dates says so: **6 reports · 4 dates**. The result count includes current values. Earlier-column values stay as draft items but do not add to this count.

When something needs you, the AI asks about it in the chat, in a few lines: a value marked unsure, a page that couldn't be read, a name on the report that differs from yours, an unclear date. Case and spacing differences do not need a question. Other differences, including an extra name or a title, do. It only reads and asks; it never saves on its own.

The results are kept as **draft items**: they wait for you and stay across restarts, but they aren't part of your record yet, so they don't count in your Overview or the AI's answers until you save them (see [Save results to your record](#save-results-to-your-record)).

### What the marks mean

Rufi checks each page the reader saves. A check never changes what the reader read; it marks it, so you look at it:

| Mark                  | Why                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| **unsure**            | The reader wasn't sure, a number doesn't match the value as printed, or a value isn't in the PDF's own text |
| **may be incomplete** | The reader counted more (or fewer) rows on the page than it saved                                           |
| **couldn't be read**  | The reader couldn't read the page, and says why                                                             |
| **not looked at**     | The reading ended without this page                                                                         |

## Save results to your record

1. Add the document to a message (**+ Add to chat** on its row on the Documents page, **Save these in the chat** on its page, or its chip from the paperclip), and say "save it". To save only some results, add them on the document's page (see [Add some results to the chat](#add-some-results-to-the-chat)) and say "save these".
2. The AI reads all the document's draft items and the results you already saved for the same tests and dates. Then it says, in a few lines, how many results are new, and names each one that isn't plainly new. It asks you about:
   - **another source**: the same result is already in your record, for example because you told the AI, or you added another copy of the report. The saved result stays as it is, and this page becomes one more source of it.
   - **a correction**: the lab amended a result you saved. The new result replaces the old one, and the old one stays in its history, marked as replaced.
   - a value marked **unsure**, a page that **couldn't be read**, or a date that isn't clear.
   - **another name** on the report. If the report isn't yours, the AI saves nothing from it. It never saves a report for someone else.
3. Answer, and say yes. When every result is plainly new and you said "save it", the AI saves at once.
4. The chat shows a receipt with a summary, for example **Saved 42 results from Sunrise Labs August.pdf · 40 new · 1 more source · 1 correction**, and the page of each one. Click **Show what was saved** to see the whole list.

What Rufi does when it saves a document's results:

- **The values as printed.** Rufi saves each result from the draft item, as the reader read it, never as the AI typed it. If you correct a value in the chat ("the LDL is 132, not 142"), Rufi saves your value and keeps your words.
- **Its date.** A result gets the date printed for it, or else the first date printed on its page, such as the collection date. Every result needs a date. When a report has no clear date, the AI asks you when the sample was taken before it saves anything. A rough date is fine, such as "around August 2026" or "early this year": Rufi saves it at the precision you gave (a month, a year) and keeps your words. If you don't know, the AI explains that it needs a date and asks for a rough one. It never makes one up.
- **Its report.** Results with the same printed lab, report number and collection date go in one report, even when they came from different documents. If any of these is missing, Rufi keeps reports from different documents apart. A page that prints none of these belongs to the report of the page before it.
- **Its sources.** Each result keeps where it came from: the document and its page, your message, or both. The receipt, the AI's reads and a visit brief show them.
- **All or nothing.** Rufi saves all the results in one step, however many there are. If one can't be saved, nothing is saved, and the AI tells you why.
- **Each result once.** A result you already saved isn't saved again: the AI gets the earlier save back.
- **Nothing changed since.** If a result changed after the AI read it (the reading went on, or you changed it), Rufi refuses the save. The AI reads the document again and asks you again.

### Results you don't want

If a result isn't yours, or was read by mistake, tell the AI. When you say yes, it sets the result aside: the chat shows a receipt such as **Dismissed 1 item from Sunrise Labs August.pdf: not saved**, and that result is never saved later. A result you already saved can't be set aside: ask the AI to remove it from your record instead.

### Undo

Say "undo that", as for any save (see [Undo](chat.md#undo)). The AI removes the results the save added, and they stay in the history. When a result became **another source**, the undo takes only that page off its sources: the result stays.

## When a reading stops

- **Rufi closed while reading:** when Rufi starts again, the reading continues where it stopped (**reading again** in the strip), with the pages it already saved. You see one start line and one end line.
- **You're signed out, or ChatGPT rejects the sign-in:** the reading waits (**waiting for sign-in**). Sign in again. Rufi checks again every 30 seconds.
- **Your plan's usage limit:** the reading waits until the limit resets (**waiting until 14:30**), then goes on.
- **The AI connection was lost or restarted:** Rufi tries once more by itself.
- **It took too long, or failed again:** the line says **Couldn't finish reading … · saved 3 of 5**, with **Retry**. The pages saved so far are kept, and no results are made until a reading finishes.

**Retry** (on the line, in **Open**, or on the Documents page) continues a reading that failed. For a document that was read with pages that couldn't be read or weren't looked at, it reads only those pages again; the results already read, and any you changed, stay as they are. You can also ask the AI in the chat to read a document again.

## Check a report

Each document has its own page, with the results the reader read beside the page they came from. Use it when you want to check a report carefully before you save it. To open it, click the document's name on the Documents page, or **Open** on the line in the chat.

Nothing on this page saves to your record. You fix what the reader read, then you save in the chat.

### Look at the results beside the page

- The results are in a list, grouped by page. Each page's heading says how its reading went, with the marks from [What the marks mean](#what-the-marks-mean). A page that couldn't be read or wasn't looked at has **Retry**.
- Click a result to show its page on the right. The arrows above the page go to the page before or after.
- Values from a report's column of earlier results are rows of their own, marked **earlier**. Rufi doesn't count them as results, here, on the Documents page or in the chat's line.
- Turn on **Unsure only** to see only the results marked unsure, each with why.
- **View original** opens the file as you added it. **The reader's work** shows what the reader saved for each page, as **Open ▸** does while it reads.

### Fix a result

1. Click the result, then click **Fix**.
2. Change what the reader read wrong: the test, value, unit, range, flag or context, exactly as the page prints it. A field you changed is outlined.
3. Click **Save fix**.

The result shows **fixed by you** and what the reader read (**The reader read: value 2.1**). Rufi keeps the reader's value beside your fix. A fix doesn't take away the **unsure** mark, so the AI still sees why the reader wasn't sure when you save. To fix a date, tell the AI in the chat.

A result you already saved or dismissed can't be fixed here.

### When another tab changed it first

If you fix a result in two tabs or windows, the second fix doesn't go over the first without you knowing. Rufi says **This result changed in another tab**, shows the value now, and keeps your text in the form. Look at the page, then click **Save my fix over it**, or **Cancel**.

Fields you didn't change take their current values from the other tab. Saving again changes only the fields you edited. If a later save fails, Rufi shows that error and keeps your text.

### Add some results to the chat

To ask about or save only some results, add them to the chat as chips:

- **One result:** point at its row and click **+ Add to chat**.
- **Several:** tick their boxes, then click **Add 2 to chat** (with the number you chose). **Clear** unticks them all.

Rufi opens the chat with their chips in the box. Type your message, for example "save these", and send it. Results you already saved or dismissed have no tick box.

### Save these in the chat

Click **Save these in the chat**. Rufi puts **Save these 42 results.** in the chat box, after anything you already typed there, with the document's chip, and opens the chat. Read it, then send it: this message goes to the AI only when you send it. The AI reads the results with your fixes, then checks them with you and saves them (see [Save results to your record](#save-results-to-your-record)).

While a message of yours is being sent, the button says **Wait: a message is being sent**.

If Rufi didn't receive the send's answer, the button says **Retry the message in the chat first**. Open the chat and retry that message before you add these results. Rufi keeps the message's text and retries the same send, so it isn't taken twice.

## Look at an original

On a document's page, click **View original**. Rufi opens the original over the page:

- A PDF opens in the built-in PDF viewer, where you can go through its pages and zoom.
- Photos show one under the other, in the order of the pages. A HEIC photo shows through a JPEG copy that Rufi made when you added it; if that copy is missing, Rufi makes it again and says **Preparing the photo…** meanwhile.

A link inside a PDF doesn't open: Rufi's window always stays in Rufi.

To close it, click **×** or press Esc. While you work in a PDF, Esc goes to the PDF viewer; click **×** instead.

In a browser that has no PDF viewer, Rufi says so and offers **Save a copy**, to open the PDF on your Mac.

## Where your documents are kept

The originals are in the `files` folder in your data folder, each named by its content's fingerprint (its SHA-256 hash). Rufi writes each file to disk completely before the document shows in Rufi. Your backups and the export hold every original (see [Backups and export](backups-and-export.md)).

You can't delete a document yet.
