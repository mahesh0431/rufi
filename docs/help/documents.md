# Documents

You can add lab reports and other documents to Rufi as PDFs or photos. Rufi keeps each original exactly as it came, so you can always look at it again, and reads each document in the background, so you don't have to type its results. This page says how to add documents, how Rufi reads them, how to check what it read, how to save the results to your health record, how to look at an original, and how to delete a document.

You can also ask the AI about a document in the chat, and it looks at the pages it needs (see [Your data and the AI](your-data-and-the-ai.md#the-pages-the-ai-looks-at)).

## Add documents

1. In the sidebar, click **Documents**.
2. Click **Add…** and choose one or more files. You can also drop files on the page.

Rufi takes PDFs and photos in JPEG, PNG or HEIC (the format of iPhone photos). It knows a file by its content, not by its name.

You can also add documents in the chat: click the paperclip next to the box, or drop files on the chat. They are added the same way, and each one's chip goes in the box (see [Adding to a message](chat.md#adding-to-a-message)). To add a document you already have to a message, click **Ask Rufi** on its row on the Documents page.

### Photos taken together

When you choose two or more photos at once, Rufi first shows them in a list, with **3 photos → one document**. This is for one report that you photographed page by page: the photos become the pages of one document.

- To change the order of the pages, drag a photo to its place. With the keyboard, go to a photo's handle and press the Up or Down arrow.
- To make each photo a document of its own, turn the switch off.
- Click **Add … documents** to add them, or **Cancel** to add nothing.

A PDF is always a document of its own, also when you add it together with photos.

### The same file again

Rufi adds each file only once for a person. When a file has the same content as a document you already added, Rufi says **was already added** and links to that document; nothing new is added. It looks at the content, so a copy with another name is found too. Two files with the same name but different content are two documents. A document you deleted doesn't count: you can add its file again, and it becomes a new document.

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
| Status   | How its reading went (see below), with **Retry** or **View reading**   |

To show one kind only, choose it in the list at the top left.

| Status              | What it means                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Not read yet**    | Never read (added before Rufi read each document); **Retry** reads it                                                       |
| **Reading**         | Rufi reads it now, or it waits its turn; it shows the pages read so far                                                     |
| **Not saved**       | Results wait for you to check and save in the chat (also values from a column of earlier results)                           |
| **To check**        | No results wait, but a page needs **Retry**                                                                                 |
| **Saved**           | Nothing waits, and results were saved to your health record; it counts the results saved, for example **Saved · 2 results** |
| **Set aside**       | Nothing waits, and every result was set aside: none was saved to your health record                                         |
| **Nothing to save** | Read, and no results were found (a letter, for example)                                                                     |
| **Failed**          | The reading stopped before the end; **Retry** continues it                                                                  |

## How Rufi reads a document

Rufi's reader is an AI that reads one document at a time, page by page, in the background. It copies what each page says: every result exactly as printed, lab results and measurements such as a blood pressure taken at a visit (`<5` stays `<5`, `130/85` stays `130/85`), with its unit, range and the lab's own flag, and the dates, lab and name printed on the page. When the page dates a measurement, such as the day of a visit, the reader copies that date with it. It doesn't judge your results, doesn't decide which are lab results and which are measurements, and saves nothing to your health record.

The reader reads each page from its image. When a PDF also has its own text, the reader uses that text as extra help with the exact characters; a scan or a photo is read from its image alone, with the same care. The reader sees only that document's pages and the name of the person you added it for, as Rufi shows it, so it can tell when a report may be someone else's. It doesn't see your health record, your chat, other documents or the internet.

Rufi reads each document as soon as you add it. It sends the document's pages to the AI you signed in with (your ChatGPT plan) to read them. The first run tells you this once.

### The reader's model and effort

In **Settings** → **Documents**, choose the **Reader model**: **GPT-6.1-Sol** (the start) or **GPT-5.5**. These are the models where Rufi can lock the reader down to its two tools, with no files and no internet (see [Your data and the AI](your-data-and-the-ai.md#reading-your-documents)).

Then choose its **Effort**: **Low**, **Medium** (the start) or **High**. Higher effort thinks longer on each page, and uses more of your plan.

Your choice is used by the next reading that starts. A reading that runs keeps the model and effort it started with; if it stops and goes on later (after Rufi restarts, or with **Retry**), it goes on with the ones chosen then.

### While a document is read

- A line in the chat says the reading started: **Reading thyrocare-aug.pdf · 5 pages**.
- Above the chat box, the reader strip shows each reading: the one at work with its pages read and time (**read 3 of 5 · 1 min**), those that wait their turn (**waiting**), and one that waits to try again by itself (**waiting to read again · read 1 of 5**). You can keep chatting meanwhile.
- Click **View reading** to see the reader's work as it goes: each page it read, with the facts and results it read, its one note for the whole document, its marks and notes (below) and how much of your plan it used. **View reading** shows only; you check and fix results on the document's page (see [Check a report](#check-a-report)). A result you fixed shows your fix there too, with what the reader read under it.

### When the reading ends

The strip item goes, and a line in the chat says what was read, for example **Lab report · 12 Aug · 42 results read · 1 to check · Open**. **Open** goes to the document's page. A document with reports of several dates says so: **6 reports · 4 dates**. The result count includes current values. Earlier-column values stay as draft items but do not add to this count.

When something needs you, the AI asks about it in the chat, in a few lines: a value the reader marked unsure, a page that couldn't be read or wasn't looked at, and what the reader noted, such as a report that may be someone else's or an unclear date. The reader judges the name on the report: your own name printed another way (initials, another order, a title, another script) doesn't need a question. The AI only reads and asks; it never saves on its own.

The results are kept as **draft items**: they wait for you and stay across restarts, but they aren't part of your health record yet, so they don't count in your Overview or your trends until you save them (see [Save results to your health record](#save-results-to-your-health-record)). When you ask about a result, the AI also reads the drafts of your documents, and it says that a value it gives from one isn't saved yet.

### What the marks mean

The reader marks what it isn't sure of, and says why. A mark never changes what the reader read; it shows you where to look:

| Mark                  | Why                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **unsure**            | The reader wasn't sure of the value, and says why. On a reading from an older Rufi, the reason may come from Rufi's own checks, such as a number that didn't match the printed value |
| **couldn't be read**  | The reader couldn't read the page, and says why                                                                                                                                      |
| **not looked at**     | The reading ended without this page                                                                                                                                                  |
| **may be incomplete** | Only on a reading from an older Rufi: the reader counted more (or fewer) rows on the page than it read                                                                               |

Something else about a page, such as rows the reader couldn't read, shows as the reader's note on that page in **View reading**.

## Save results to your health record

1. Add the document to a message (**Ask Rufi** on its row on the Documents page, **Save in chat** on its page, or its chip from the paperclip), and say "save it". To save only some results, add them on the document's page (see [Add some results to the chat](#add-some-results-to-the-chat)) and say "save these".
2. The AI reads all the document's draft items and the results you already saved for the same tests and dates. Then it says, in a few lines, how many results are new, which are lab results and which are measurements, and names each one that isn't plainly new. It asks you about:
   - **another source**: the same result is already in your health record, for example because you told the AI, or you added another copy of the report. The saved result stays as it is, and this page becomes one more source of it. When you say a result is a duplicate, the AI asks in one question whether to add this page as another source or to set the result aside.
   - **a correction**: the lab amended a result you saved. The new result replaces the old one, and the old one stays in its history, marked as replaced.
   - a value marked **unsure**, a page that **couldn't be read**, or a date that isn't clear.
   - **another name** on the report. If the report isn't yours, the AI saves nothing from it. It never saves a report for someone else.
3. Answer, and say yes. When every result is plainly new and you said "save it", the AI saves at once.
4. Lab results go to the Lab results page and measurements to Measurements (see [Lab results and Measurements](record.md#lab-results-and-measurements)). The chat shows a receipt with a summary, for example **Saved 42 results from Sunrise Labs August.pdf · 40 new · 1 more source · 1 correction**, and the page of each one. Click **Show what was saved** to see the whole list.

What Rufi does when it saves a document's results:

- **The values as printed.** Rufi saves each result from the draft item, as the reader read it, never as the AI typed it. If you correct a value in the chat ("the LDL is 132, not 142"), Rufi saves your value and keeps your words.
- **Its date.** A lab result gets the date printed for it, or else the first date printed on its page, such as the collection date. Every result needs a date. When a report has no clear date, the AI asks you when the sample was taken before it saves anything. A rough date is fine, such as "around August 2026" or "early this year": Rufi saves it at the precision you gave (a month, a year) and keeps your words. If you don't know, the AI explains that it needs a date and asks for a rough one. It never makes one up. A measurement's date is the day it was taken: it gets only the date printed for it, or the one you give, never the report's collection date.
- **Its report.** Results with the same printed lab, report number and collection date go in one report, even when they came from different documents. If any of these is missing, Rufi keeps reports from different documents apart. A page that prints none of these belongs to the report of the page before it.
- **Its sources.** Each result keeps where it came from: the document and its page, your message, or both. The receipt, the AI's reads and a visit brief show them.
- **All or nothing.** Rufi saves all the results in one step, however many there are. If one can't be saved, nothing is saved, and the AI tells you why.
- **Each result once.** A result you already saved isn't saved again: the AI gets the earlier save back.
- **Nothing changed since.** If a result changed after the AI read it (the reading went on, or you changed it), Rufi refuses the save. The AI reads the document again and asks you again.

### Results you don't want

If a result isn't yours, or was read by mistake, tell the AI. When you say yes, it sets the result aside: the chat shows a receipt such as **Set aside 1 item from Sunrise Labs August.pdf: not saved**, and that result is never saved later. A result you already saved can't be set aside: ask the AI to remove it from your health record instead.

### Undo

Say "undo that", as for any save (see [Undo](chat.md#undo)). The AI removes the results the save added, and they stay in the history. When a result became **another source**, the undo takes only that page off its sources: the result stays.

## When a reading stops

- **Rufi closed while reading:** when Rufi starts again, the reading continues where it stopped (**reading again** in the strip), with the pages it already read. You see one start line and one end line.
- **You're signed out, your sign-in has ended, or your plan's usage limit is reached:** the reading stops at once. The line says why, in Rufi's or the service's words, for example **Couldn't finish reading … · Not signed in. Sign in with ChatGPT: in Rufi, or with pnpm rufi signin. · read 0 of 5**, with **Retry**. Sign in, or wait until the limit resets, then click **Retry**. Rufi doesn't try again by itself. If you add several documents meanwhile, each one stops the same way and has its own **Retry**.
- **The AI connection was lost or restarted, or ChatGPT can't renew your sign-in just now:** Rufi tries again by itself, up to three times: after 30 seconds, then 1 minute, then 2 minutes. Meanwhile the strip says **waiting to read again**.
- **It took too long, or failed again:** the line says **Couldn't finish reading … · read 3 of 5**, with **Retry**. Between them is why: "the reading took too long", or the AI service's error as the service reported it, such as "exceeded retry limit, last status: 429 Too Many Requests". The pages read so far are kept, and no results are made until a reading finishes.

**View reading** and the document's page also say why a reading failed, in full.

**Retry** (on the line, in **View reading**, or on the Documents page) continues a reading that failed. For a document that was read with pages that couldn't be read or weren't looked at, it reads only those pages again; the results already read, and any you changed, stay as they are. You can also ask the AI in the chat to read a document again.

## Check a report

Each document has its own page, with the results the reader read beside the page they came from. Use it when you want to check a report carefully before you save it. To open it, click the document's name on the Documents page, or **Open** on the line in the chat.

Nothing on this page saves to your health record. You fix what the reader read, then you save in the chat.

When every result is saved or set aside, the page says **These results were saved to your health record.** If you set every result aside, it says **Nothing from this document was saved to your health record.** Its count says what was saved and set aside, for example **2 saved · 1 set aside**, and it has no **Save in chat**. **View reading** says the same. These say what was saved from the document: if you later undo a saved result in the chat, the page and the Documents list still count it as saved.

### Look at the results beside the page

- The results are in a list, grouped by page. Each page's heading says how its reading went, with the marks from [What the marks mean](#what-the-marks-mean). A page that couldn't be read or wasn't looked at has **Retry**.
- Click a result to show its page on the right. The arrows above the page go to the page before or after.
- Values from a report's column of earlier results are rows of their own, marked **earlier**. Rufi doesn't count them as results, here, on the Documents page or in the chat's line.
- Turn on **Unsure only** to see only the results marked unsure, each with why.
- **View original** opens the file as you added it. **View reading** shows what the reader read on each page, also while it reads.

### Fix a result

1. Click the result, then click **Fix**.
2. Change what the reader read wrong: the test, value, unit, range, flag or context, exactly as the page prints it. A field you changed is outlined.
3. Click **Save fix**.

The result shows **fixed by you** and what the reader read (**The reader read: value 2.1**). Rufi keeps the reader's value beside your fix. A fix doesn't take away the **unsure** mark, so the AI still sees why the reader wasn't sure when you save. To fix a date, tell the AI in the chat.

A result you already saved or set aside can't be fixed here.

### When another tab changed it first

If you fix a result in two tabs or windows, the second fix doesn't go over the first without you knowing. Rufi says **This result changed in another tab**, shows the value now, and keeps your text in the form. Look at the page, then click **Replace fix**, or **Cancel**.

Fields you didn't change take their current values from the other tab. Saving again changes only the fields you edited. If a later save fails, Rufi shows that error and keeps your text.

### Add some results to the chat

To ask about or save only some results, add them to the chat as chips: click **Ask Rufi** on a result's row, for each one you want. You stay on the page, and the chat bar shows what you added. Then click the bar, type your message, for example "save these", and send it. Results you already saved or set aside have no **Ask Rufi**.

### Save in chat

Click **Save in chat**. Rufi puts **Save these 42 results.** in the chat box, after anything you already typed there, with the document's chip. You stay on the page, so you can read the results beside it. Click the chat bar, read the message, then send it: this message goes to the AI only when you send it. The AI reads the results with your fixes, and what the reader read beside each fix, then checks them with you and saves them (see [Save results to your health record](#save-results-to-your-health-record)).

While a message of yours is being sent, Rufi says **Wait: a message is being sent.** beside the button.

If Rufi didn't receive the send's answer, Rufi says **Retry the message in the chat first.** beside the button. Open the chat and retry that message before you add these results. Rufi keeps the message's text and retries the same send, so it isn't taken twice.

## Look at an original

On a document's page, click **View original**. Rufi opens the original over the page:

- A PDF opens in the built-in PDF viewer, where you can go through its pages and zoom.
- Photos show one under the other, in the order of the pages. A HEIC photo shows through a JPEG copy that Rufi made when you added it; if that copy is missing, Rufi makes it again and says **Preparing the photo…** meanwhile.

A link inside a PDF doesn't open: Rufi's window always stays in Rufi.

To close it, click **×** or press Esc. While you work in a PDF, Esc goes to the PDF viewer; click **×** instead.

In a browser that has no PDF viewer, Rufi says so and offers **Save a copy**, to open the PDF on your Mac.

## Where your documents are kept

The originals are in the `files` folder in your data folder, exactly as you added them. Your backups and the export hold every original (see [Backups and export](backups-and-export.md)).

## Delete a document

Delete a document that you added by mistake, for example someone else's report or a blurred copy, or a file you no longer want to keep in Rufi. This removes the document from Rufi. To take one wrong result out of your health record and keep the document, ask the AI in the chat instead (see [Undo](chat.md#undo)).

1. Open the document's page: click its name on the Documents page.
2. Click **Delete**. Rufi shows what goes and what stays.
3. Click **Delete** again.

Rufi goes back to the Documents page, and a line in the chat says **Deleted Sunrise Labs August.pdf**. Rufi tells the AI at once, and it answers in a short line.

### When results from it are in your health record

If you saved results from the document, Rufi lists each saved result that comes from it. A result that an amended result replaced is in the list too, marked **replaced**: it comes back if the amended one is removed. A result you already removed isn't in the list. Choose one of the two buttons; neither is chosen for you:

- **Delete file:** the file goes, and the results stay in your health record. Use this when the results are right and you only want the file gone, for example a second copy of a report. Their sources say **Document deleted (Sunrise Labs August.pdf, page 2)**.
- **Delete file and results:** the file goes, and the chat opens. The AI starts by itself: it lists the results from the document and asks you about them. When you say yes, it removes them from your health record. For a result that you also gave in another way (you told the AI, or another document has it), it asks to take only this document off it: the result stays, with its other sources. The AI removes nothing before your yes.

Your health record changes only in the chat, with your yes. The delete itself removes no result.

**If you stop halfway.** The file is already gone. The results that the AI didn't remove stay in your health record, as with **Delete file**. The AI's question stays in the chat: answer it when you like, or ask the AI about the document's results later. If Rufi closed before the AI could ask, Rufi's note waits above the chat box until you send a message (see [Waiting messages](chat.md#waiting-messages)).

**Undo.** "Undo that" in the chat brings back a result the AI removed. It doesn't bring back the file, or a page that the AI took off a result.

### What goes, and what stays

| Goes from Rufi                                        | Stays                                                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| The original file and the pages Rufi drew from it     | Your health record, with its history and receipts                                            |
| What the reader read: its notes and the unsaved items | The chat: your messages, the AI's replies and Rufi's lines                                   |
| A reading that waits or runs: it stops                | Visit briefs, as they were written                                                           |
|                                                       | The document's name and page numbers, so that what points at it can say **document deleted** |

After the delete, a chip of the document in an old message says **document deleted** and opens nothing. A reading's line about it has no **Open** or **Retry**. A saved result's sources say **Document deleted (Sunrise Labs August.pdf, page 2)**. A result you removed before can still come back with "undo that"; its source says **document deleted**. The document itself can't come back: add its file again if you need it.

If another person in Rufi has the same file, Rufi keeps the file for them.

If the document changed while you looked at its preview (for example, you saved a result from it in another tab), Rufi doesn't delete it. It says **Something changed since you opened this** and shows how it is now.

### Copies Rufi can't reach

A delete removes the document from Rufi's data folder. Copies outside it stay:

- **Rufi's backups** keep the document until they age out, in about 5 weeks. Backups made before an update keep it until you remove them (see [Backups and export](backups-and-export.md#deleted-documents-in-backups)).
- **Exports** you saved keep it.
- **Time Machine** and other backups of your Mac keep it.
- **The AI** may remember what it already read in this chat. Rufi's tools no longer show it the document's pages, and Rufi tells it at once that you deleted the document, and not to use or quote what it read from its pages. Results that you kept stay facts in your health record: the AI reads them as it reads any result, and says the document was deleted.
