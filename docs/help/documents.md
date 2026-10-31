# Documents

You can add lab reports and other documents to Rufi as PDFs or photos. Rufi keeps each original exactly as it came, so you can always look at it again, and reads each document when you send it, so you don't have to type its results: Rufi's reader copies each page, then Rufi AI sorts the file into documents and drafts their results. This page says how to add documents, how Rufi reads and sorts them, how to check the drafts, how to save the results to your health record, how to look at an original, and how to delete a document.

You can also ask the AI about a document in the chat, and it looks at the pages it needs (see [Your data and the AI](your-data-and-the-ai.md#the-pages-the-ai-looks-at)).

## Add documents

Files always go through the chat, and nothing starts until you send them:

1. In the sidebar, click **Documents**.
2. Click **Add…** and choose one or more files. You can also drop files on the page. The chat opens, and each file's chip goes in its box (see [Adding to a message](chat.md#adding-to-a-message)).
3. Type what you want to know or do with them, or nothing, and send. Rufi then reads the files, and Rufi AI sorts them and answers you in one reply.

Rufi takes PDFs and photos in JPEG, PNG or HEIC (the format of iPhone photos). It knows a file by its content, not by its name.

You can also add files in the chat itself: click the paperclip next to the box, or drop files on the chat. It is the same: each file's chip goes in the box. If you cancel the file picker, the chat stays open with an empty box; press Esc to close it. To add a document you already have to a message, click **Ask Rufi** on its row on the Documents page.

A file you add isn't read, and isn't listed on the Documents page, until you send it. Rufi keeps it in the box with its chip, also when you reload or Rufi starts again. To remove it, click its chip's **×**: a file that was never sent is removed from Rufi, with its pages. Zip files and folders aren't added yet.

### Photos taken together

When you choose two or more photos at once, Rufi first shows them in a list, with **3 photos → one document**. This is for one report that you photographed page by page: the photos become the pages of one document.

- To change the order of the pages, drag a photo to its place. With the keyboard, go to a photo's handle and press the Up or Down arrow.
- To make each photo a document of its own, turn the switch off.
- Click **Add … documents** to add them, or **Cancel** to add nothing.

A PDF is always a document of its own, also when you add it together with photos.

### The same file again

Rufi adds each file only once for a person. When a file has the same content as a document you already added (or one that waits in the box), Rufi says **was already added** and links to that document; nothing new is added. It looks at the content, so a copy with another name is found too. Two files with the same name but different content are two documents. A document you deleted doesn't count: you can add its file again, and it becomes a new document.

### When Rufi doesn't add a file

If one of the files isn't a PDF, JPEG, PNG or HEIC photo, is damaged, or is a PDF protected with a password, Rufi says which file and why, and adds none of the files you chose. Remove that file and add the others again. For a PDF with a password, save a copy without the password and add that.

## Your documents

The Documents page lists every document you sent, newest first:

| Column   | What it shows                                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document | The file's name as you added it, and its pages or how many more photos; for a document Rufi AI sorted out of a file, its pages, such as **pages 1–2 of 5** |
| Kind     | A lab report, prescription, letter or other; empty until Rufi AI sorts it                                                                                  |
| Date     | The document's date: a report's collection date, a prescription's or letter's own date; empty until Rufi AI sorts it                                       |
| Added    | The day you added it                                                                                                                                       |
| Status   | How its reading and sorting went (see below), with **Retry** or **View reading**                                                                           |

To show one kind only, choose it in the list at the top left.

| Status              | What it means                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Not read yet**    | Sent, but not read (an older file, or a reading that never began); **Retry** reads it                                           |
| **Reading**         | Rufi's reader copies it now, or waits for another reading; it shows the pages copied so far, for example **Reading · 13 of 40** |
| **Not sorted yet**  | Read, but Rufi AI hasn't sorted it (see [When a file isn't sorted](#when-a-file-isnt-sorted))                                   |
| **Not saved**       | Results wait for you to check and save in the chat (also values from a column of earlier results)                               |
| **To check**        | No results wait, but a page needs **Retry**                                                                                     |
| **Saved**           | Nothing waits, and results were saved to your health record; it counts the results saved, for example **Saved · 2 results**     |
| **Set aside**       | Nothing waits, and every result was set aside: none was saved to your health record                                             |
| **Nothing to save** | Read, and no results were found (a letter, for example)                                                                         |
| **Failed**          | The reading stopped before the end; **Retry** continues it                                                                      |

## How Rufi reads a document

Rufi reads a file in two steps. First its **reader**, an AI that sees one file at a time, copies each page, exactly as printed, as text with its tables: every value (`<5` stays `<5`, `1,25` stays `1,25`), unit, range, the lab's own flag, the dates, names and everything else on the page. Where something is unclear, such as a smudged digit, handwriting or a crossed-out value, it marks it in the copy, for example `1[0?]4`. The reader decides nothing: not what the file is, not its date, not which values are results. It saves nothing to your health record.

The reader reads each page from its image. When a PDF also has its own text, the reader uses that text as extra help with the exact characters; a scan or a photo is read from its image alone, with the same care. The reader sees only that file's pages. It doesn't see whose document it is, your health record, your chat, other documents or the internet.

Then **Rufi AI**, the AI you chat with, sorts the file, in the same reply (see [How Rufi AI sorts a file](#how-rufi-ai-sorts-a-file)).

Rufi reads each document when you send it, as the first part of your reply: **Rufi's part**. It sends the document's pages to the AI you signed in with (your ChatGPT plan) to read them, and their copies to Rufi AI to sort them. The first run tells you this once. A document that was already read isn't read again when you send it again; only a page you ask to read again is (see [Retry](#retry)).

### The reader's model and effort

In **Settings** → **Documents**, choose the **Reader model**: **GPT-6.1-Sol** (the start) or **GPT-5.5**. These are the models where Rufi can lock the reader down to its two tools, with no files and no internet (see [Your data and the AI](your-data-and-the-ai.md#reading-your-documents)).

Then choose its **Effort**: **Low**, **Medium** (the start) or **High**. Higher effort thinks longer on each page, and uses more of your plan.

Your choice is used by the next reading that starts. A reading that runs keeps the model and effort it started with; if it stops and goes on later (with **Retry**), it goes on with the ones chosen then.

### While a document is read

- Your reply starts at once, with your message. Its Activity is open (see [Activity](chat.md#activity)) and shows a step for each file, **Rufi's reader · thyrocare-aug.pdf**, with how far it is (**13 of 60 pages**). Files are copied one after another, in the order you sent them. Rufi AI starts when all are copied.
- A reading waits when another reading is at work, also another person's: the step says **waiting for another reading**.
- The chat bar shows the turning circle, and **Steer**, **Queue** and **Stop** are where the send button was (see [While the AI replies](chat.md#while-the-ai-replies)).
- On the Documents page, the file's row says **Reading · 13 of 60**, with **View reading**. It has no **Ask Rufi** meanwhile.
- Click **View reading** to see the reader's work as it goes: each page's copy as the reader saved it, with its marks, what couldn't be read and why, and how much of your plan it used. **View reading** shows only; you check and fix the drafts on the document's page (see [Check a report](#check-a-report)).
- A message you send meanwhile goes as you choose: steered, it goes into this reply once Rufi AI starts; queued, it waits for a reply of its own (see [While the AI replies](chat.md#while-the-ai-replies)).

### When the reading ends

The step ends with the pages copied, for example **60 pages · 1 couldn't be read**. When a page couldn't be read or wasn't looked at, Rufi AI is told which, and says so in its answer. Rufi writes no line in the chat for a reading: the step in Activity is its record.

When the reading doesn't finish, your reply ends before Rufi AI starts (see [When a reading stops](#when-a-reading-stops)).

## How Rufi AI sorts a file

When a reading ends, Rufi gives your message to Rufi AI with a short note: which documents were just copied, and which pages couldn't be read. Rufi AI reads the page copies, sorts the new files, and then answers what you wrote. If you sent files and no words, it tells you in a few lines what it found. It can't save anything to your health record, set anything aside or write a visit brief until you say yes in the chat.

- **It splits the file into documents**, one for each report or paper, and gives each its kind, its date and, for a report, its lab and report number as printed. A report's pages stay together, also a page that goes on with its table and prints no lab or date. A prescription or a letter is a document of its own. Each one has its own row on the Documents page, with its pages: **mixed-pile.pdf · pages 1–2 of 5**, **pages 3–4 of 5**, **page 5 of 5**.
- **It drafts the results**: every current lab result, and measurements such as a blood pressure taken at a visit, each with its date and the words it came from on its page. A column of earlier results isn't drafted. A prescription's medicines and advice aren't drafted: they go in its visit (see [A visit's paper](#a-visits-paper)).
- **It says what is worth a look**, in a few plain words: a digit the reader marked unclear, a value written by hand, or crossed out and written again. Most results need none. Where the reader marked a digit unclear, the draft's value is Rufi AI's reading (**104**), the value that would be saved; the marks (**1[0?]4**) stay in the words it came from.
- **It tells you in a few lines** what it found, for example "I sorted mixed-pile.pdf into 3 documents: a Sunrise Labs report from 12 Mar 2026 (14 results, 1 worth a look), a Northgate report from 20 Aug 2026 (12 results) and a prescription from 3 Sep 2026 (3 measurements). Nothing is saved yet." When it can't tell, for example whether two reports are one, or whose a report is, it asks you instead, and sorts once you answer.

The same report added twice, such as a PDF and a photo of it, stays two documents. Rufi AI says it looks like another copy; when you save, it offers the results as another source of the ones already saved.

A file is sorted all at once, or not at all: if Rufi can't keep the sort (for example, it leaves a page out), it keeps none of it and tells Rufi AI why, and it tries again. What a draft says is Rufi AI's reading of the page; you check it before you save.

The drafts are kept as **draft items**: they wait for you and stay across restarts, but they aren't part of your health record yet, so they don't count in your Overview or your trends until you save them (see [Save results to your health record](#save-results-to-your-health-record)). When you ask about a result, the AI also reads the drafts of your documents, and it says that a value it gives from one isn't saved yet.

### When a file isn't sorted

A file that was read and not sorted shows **Not sorted yet** on the Documents page and on its own page, and has **Ask Rufi**:

- **Rufi AI asked you about it.** Answer in the chat, and Rufi AI sorts it then.
- **The AI's part of the reply failed or was stopped** after the reading. The copies are kept, and nothing is copied again. Send the file's chip again (**Ask Rufi** on its row), or say "sort it", and Rufi AI sorts it.

Rufi doesn't sort a file on its own, and doesn't try again by itself: a file is sorted in a reply to a message of yours. A file Rufi sorted in an earlier version, and could not finish, shows the same.

### A file sorted wrong

Tell the AI in the chat, for example "pages 3 and 4 are one letter". It sorts that file again in your reply, as you say: the drafts of the pages that change are made again. Drafts you fixed, set aside or saved stay as they are, and move with their page. A document keeps the kind, lab and date you don't correct. A page that a saved result came from can't move to another document: the AI tells you so.

### What the marks mean

Marks show you where to look. A mark never changes a value:

| Mark                  | Why                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Worth a look**      | Rufi AI says why you should check this draft, such as an unclear digit. On a reading from an older Rufi, it is why the reader wasn't sure |
| **couldn't be read**  | The reader couldn't read the page, and says why                                                                                           |
| **not looked at**     | The reading ended without this page                                                                                                       |
| **may be incomplete** | Only on a reading from an older Rufi: the reader counted more (or fewer) rows on the page than it read                                    |

## Save results to your health record

1. Add the document to a message (**Ask Rufi** on its row on the Documents page, **Save in chat** on its page, or its chip from the paperclip), and say "save it". A new file is read and sorted first, in the same reply, and the AI asks you before it saves. To save only some results, add them on the document's page (see [Add some results to the chat](#add-some-results-to-the-chat)) and say "save these".
2. The AI reads all the document's draft items and the results you already saved for the same tests and dates. Then it says, in a few lines, how many results are new, which are lab results and which are measurements, and names each one that isn't plainly new. It asks you about:
   - **another source**: the same result is already in your health record, for example because you told the AI, or you added another copy of the report. The saved result stays as it is, and this page becomes one more source of it. When you say a result is a duplicate, the AI asks in one question whether to add this page as another source or to set the result aside.
   - **a correction**: the lab amended a result you saved. The new result replaces the old one, and the old one stays in its history, marked as replaced.
   - a draft **worth a look**, a page that **couldn't be read**, or a date that isn't clear.
   - **another name** on the report. If the report isn't yours, the AI saves nothing from it. It never saves a report for someone else.
3. Answer, and say yes. When every result is plainly new and you said "save it", the AI saves at once.
4. Lab results go to the Lab results page and measurements to Measurements (see [Lab results and Measurements](record.md#lab-results-and-measurements)). The chat shows a receipt with a summary, for example **Saved 42 results from Sunrise Labs August.pdf · 40 new · 1 more source · 1 correction**, and the page of each one. Click **Show what was saved** to see the whole list.

What Rufi does when it saves a document's results:

- **The values as printed.** Rufi saves each result from the draft item, as it was drafted from the page (with your fix, if you made one), never as the AI typed it when saving. If you fixed a value on the document's page, the AI reads its number for the trends as it saves, for example 4.6 for **4,6**, and asks you when it isn't sure. If you correct a value in the chat ("the LDL is 132, not 142"), Rufi saves your value and keeps your words.
- **Its date.** A result gets the date Rufi AI drafted for it: for a lab result, its report's collection date as printed; for a measurement, the day it was taken. Every result needs a date. When a report has no clear date, the AI asks you when the sample was taken before it saves anything. A rough date is fine, such as "around August 2026" or "early this year": Rufi saves it at the precision you gave (a month, a year) and keeps your words. If you don't know, the AI explains that it needs a date and asks for a rough one. It never makes one up. A measurement's date is the day it was taken: it gets only the date printed for it, or the one you give, never the report's collection date.
- **Its report.** The results of one document go in one report, with the lab, report number and date Rufi AI gave the document.
- **Its sources.** Each result keeps where it came from: the document and its page, your message, or both. The receipt, the AI's reads and a visit brief show them.
- **All or nothing.** Rufi saves all the results in one step, however many there are. If one can't be saved, nothing is saved, and the AI tells you why.
- **Each result once.** A result you already saved isn't saved again: the AI gets the earlier save back. After an undo, you can ask the AI to save it again.
- **Nothing changed since.** If a result changed after the AI read it (it was sorted again, or you changed it), Rufi refuses the save. The AI reads the document again and asks you again. Each draft remembers which reading of its page it was drafted from. If the page was read again after that reading, the draft is **out of date**: Rufi refuses to save it, and the AI saves the page's new drafts instead.

### Results you don't want

If a result isn't yours, or was read by mistake, tell the AI. When you say yes, it sets the result aside: the chat shows a receipt such as **Set aside 1 item from Sunrise Labs August.pdf: not saved**, and that result is never saved later. A result you already saved can't be set aside: ask the AI to remove it from your health record instead.

### Undo

Say "undo that", as for any save (see [Undo](chat.md#undo)). The AI removes the results the save added, and they stay in the history. When a result became **another source**, the undo takes only that page off its sources: the result stays. To save it again, ask the AI, for example "save page 2 as a source again". It asks first, and the chat shows a new receipt. When the undo removed the result, the AI puts it back first, so you see two receipts: one for the result put back, then one for the page added as its source.

## A visit's paper

A prescription, an e-prescription or a discharge summary is the paper from a visit to a doctor. When Rufi AI tells you what it found in one, it also says what the paper holds, which of its medicines are already in your health record, and proposes saving it as a visit. It asks **Are you taking these?** and saves nothing yet.

Answer in the chat, for example "only the Levothyroxine; add the follow-ups". The AI saves it all in one save, with one receipt:

- **the visit**, with the doctor's words as the paper has them, and the paper's page as its source;
- **each medicine you said you take**, with the visit as its source. One already in your health record keeps its details and gets the visit as one more source. A medicine you don't take stays only in the doctor's words;
- **follow-ups** for the tests and the next visit, when you said yes to them.

The paper's page shows **Saved as** with each visit saved from it; click one to open the visit (see [A visit](record.md#a-visit)). This doesn't mean everything on the paper is saved. When the paper may be someone else's, the AI asks whose it is and saves nothing until you say. Say "undo that" to take the visit back (see [Undo](chat.md#undo)).

You can also tell the AI about a visit with no paper, such as a video call with your doctor; it saves it the same way, with your words as the doctor's words. When the paper comes later, the AI adds it to the visit you have instead of making a second one.

## When a reading stops

Your reply stops in Rufi's part, before Rufi AI starts on your message. Its last line says why and how far it got, with **Retry**. The pages already copied are kept, and Rufi AI never gets half a message.

- **You clicked Stop:** the step says **stopped · 13 of 60**, and the reply ends **Stopped. · read 13 of 60**. As after any Stop, nothing more goes by itself until you send a message.
- **You're signed out, your sign-in has ended, or your plan's usage limit is reached:** the reading stops at once. The line says why, in Rufi's or the service's words, for example **Couldn't read scan-2024.pdf · Not signed in. Sign in with ChatGPT: in Rufi, or with pnpm rufi signin. · read 13 of 60**. Sign in, or wait until the limit resets, then click **Retry**. Rufi doesn't try again by itself.
- **The AI connection was lost or restarted, or ChatGPT can't renew your sign-in just now:** Rufi tries again by itself, up to three times: after 30 seconds, then 1 minute, then 2 minutes. Meanwhile the step says **waiting to copy again**.
- **It took too long, or failed again:** the line says **Couldn't read … · read 3 of 5**. Between them is why: "the reading took too long", or the AI service's error as the service reported it, such as "exceeded retry limit, last status: 429 Too Many Requests".
- **Rufi closed while reading:** when Rufi starts again, the reply ends **Rufi closed while reading.**, with **Retry**. Nothing goes on by itself after a restart.

**View reading** and the document's page also say why a reading failed, in full. On the Documents page, the file shows **Failed**.

### Retry

**Retry** on a reply's last line sends the same message again, without showing it twice, and the reading goes on from the next page not copied. You must be signed in, as for any send.

A file whose reading failed also has **Retry** on the Documents page and on its own page, and a page that couldn't be read or wasn't looked at has it on its heading. These put the document's chip in the chat box, marked **· read again**, and open the chat. Nothing is read until you send; if you take the chip out, nothing was queued. When you send, Rufi reads only the pages that couldn't be read or weren't looked at, in your reply, and Rufi AI sorts just those pages into their document: the drafts already made, and any you changed, stay as they are. Sending a document's chip again, without that mark, doesn't read its unreadable pages again, so "save it" never waits for a page that can't be read.

You can also ask the AI in the chat about a document that wasn't read; it tells you to press **Retry**.

## Check a report

Each document has its own page, with its drafts beside the page they came from. Its heading says what Rufi AI sorted it as, for example **mixed-pile.pdf · Lab report · pages 1–2 of 5 · Sunrise Labs · 12 Mar 2026 · added 18 Oct 2026**. Use it when you want to check a report carefully before you save it. To open it, click the document's name on the Documents page.

Nothing on this page saves to your health record. You fix what was drafted wrong, then you save in the chat.

When every result is saved or set aside, the page says **These results were saved to your health record.** If you set every result aside, it says **Nothing from this document was saved to your health record.** Its count says what was saved and set aside, for example **2 saved · 1 set aside**, and it has no **Save in chat**. **View reading** says the same. These say what was saved from the document: if you later undo a saved result in the chat, the page and the Documents list still count it as saved.

### Look at the results beside the page

- The results are in a list, grouped by page. Each page's heading says how its reading went, with the marks from [What the marks mean](#what-the-marks-mean). A page that couldn't be read or wasn't looked at has **Retry**.
- Each draft shows the words it came from, **From the page: “Glucose, Fasting | 1[0?]4 H | mg/dL”**, and, when it is worth a look, why: **Worth a look: the middle digit is smudged**.
- Click a result to show its page on the right. The arrows above the page go to the page before or after; under it, where that page is in the file, such as **Page 1 of 2 (page 3 of 5 in the file)**.
- On a reading from an older Rufi, values from a report's column of earlier results are rows of their own, marked **earlier**. Rufi doesn't count them as results.
- Turn on **Worth a look only** to see only the drafts worth a look, each with why.
- A draft marked **Out of date: this page was read again** comes from an earlier reading of its page; it can't be fixed or saved.
- **View original** opens the file as you added it. **View reading** shows the reader's copy of each page, also while it reads.

### Fix a result

1. Click the result, then click **Fix**.
2. Change what was drafted wrong: the test, value, unit, range, flag or context, exactly as the page prints it. A field you changed is outlined.
3. Click **Save fix**.

The result shows **fixed by you** and what was drafted (**Drafted: value 2.1**; on a reading from an older Rufi, **The reader read: value 2.1**). Rufi keeps the drafted value beside your fix, and your value as you typed it. A fix doesn't take away **Worth a look**, so the AI still sees why when you save. To fix a date, tell the AI in the chat.

A result you already saved or set aside can't be fixed here.

### When another tab changed it first

If you fix a result in two tabs or windows, the second fix doesn't go over the first without you knowing. Rufi says **This result changed in another tab**, shows the value now, and keeps your text in the form. Look at the page, then click **Replace fix**, or **Cancel**.

Fields you didn't change take their current values from the other tab. Saving again changes only the fields you edited. If a later save fails, Rufi shows that error and keeps your text.

### Add some results to the chat

To ask about or save only some results, add them to the chat as chips: click **Ask Rufi** on a result's row, for each one you want. You stay on the page, and the chat bar shows what you added. Then click the bar, type your message, for example "save these", and send it. Results you already saved or set aside have no **Ask Rufi**.

### Save in chat

Click **Save in chat**. Rufi puts **Save these 42 results.** in the chat box, after anything you already typed there, with the document's chip. You stay on the page, so you can read the results beside it. Click the chat bar, read the message, then send it: this message goes to the AI only when you send it. The AI reads the results with your fixes, and what was drafted beside each fix, then checks them with you and saves them (see [Save results to your health record](#save-results-to-your-health-record)).

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

Rufi goes back to the Documents page, and a line in the chat says **Deleted Sunrise Labs August.pdf**. Rufi tells the AI at once, and it answers in a short line. If the file was being read, the reading stops: its step in your reply ends **deleted**, and the reply goes on with the other files.

When Rufi AI sorted a file into several documents, each one is deleted on its own: delete one, and the others of the file stay, with their pages and drafts.

### When results from it are in your health record

If you saved results from the document, Rufi lists each saved result that comes from it. A result that an amended result replaced is in the list too, marked **replaced**: it comes back if the amended one is removed. A result you already removed isn't in the list. Choose one of the two buttons; neither is chosen for you:

- **Delete file:** the file goes, and the results stay in your health record. Use this when the results are right and you only want the file gone, for example a second copy of a report. Their sources say **Document deleted (Sunrise Labs August.pdf, page 2)**.
- **Delete file and results:** the file goes, and the chat opens. The AI starts by itself: it lists the results from the document and asks you about them. The list in the dialog is what rests on the document's pages. Medicines or follow-ups saved from a visit here aren't listed; Rufi AI goes through them with you. A medicine you also told it you take stays, with only the visit taken off. When you say yes, it removes them from your health record. For a result that you also gave in another way (you told the AI, or another document has it), it asks to take only this document off it: the result stays, with its other sources. The AI removes nothing before your yes.

Your health record changes only in the chat, with your yes. The delete itself removes no result.

**If you stop halfway.** The file is already gone. The results that the AI didn't remove stay in your health record, as with **Delete file**. The AI's question stays in the chat: answer it when you like, or ask the AI about the document's results later. If Rufi closed before the AI could ask, Rufi's note goes to the AI when Rufi starts again (see [Rufi's lines](chat.md#rufis-lines)).

**Undo.** "Undo that" in the chat brings back a result the AI removed. It doesn't bring back the file, or a page that the AI took off a result.

### What goes, and what stays

| Goes from Rufi                                          | Stays                                                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| The original file and the pages Rufi drew from it       | Your health record, with its history and receipts                                            |
| The reader's copies of its pages and its unsaved drafts | The chat: your messages, the AI's replies and Rufi's lines                                   |
| A reading that waits or runs: it stops                  | Visit briefs, as they were written                                                           |
| The AI's working notes on it                            |                                                                                              |
|                                                         | The document's name and page numbers, so that what points at it can say **document deleted** |

After the delete, a chip of the document in an old message says **document deleted** and opens nothing. A reading line about it from an earlier version has no **Open** or **Retry**. A saved result's sources say **Document deleted (Sunrise Labs August.pdf, page 2)**, and so do a visit's: the visit stays, with the records saved from it. A result you removed before can still come back with "undo that"; its source says **document deleted**. The document itself can't come back: add its file again if you need it.

If another person in Rufi has the same file, Rufi keeps the file for them.

**One document of a split file.** When Rufi AI split a file into documents, deleting one of them deletes its pages only: their copies and drafts. The preview shows them, for example **Its part of the file: pages 3–4 of 5**. The file stays while the file's other documents use it, and the preview says so, for example **The file: 2 other documents use it**. It goes with the last of them.

If the document changed while you looked at its preview (for example, you saved a result from it in another tab), Rufi doesn't delete it. It says **Something changed since you opened this** and shows how it is now.

### Copies Rufi can't reach

A delete removes the document from Rufi's data folder. Copies outside it stay:

- **Rufi's backups** keep the document until they age out, in about 5 weeks. Backups made before an update keep it until you remove them (see [Backups and export](backups-and-export.md#deleted-documents-in-backups)).
- **Exports** you saved keep it.
- **The AI's folder** keeps files the AI made from it, apart from its working notes on the document, which Rufi removes (see [Your data and the AI](your-data-and-the-ai.md#what-the-ai-can-do-in-its-folder)).
- **Time Machine** and other backups of your Mac keep it.
- **The AI** may remember what it already read in this chat. Rufi's tools no longer show it the document's pages, and Rufi tells it at once that you deleted the document, and not to use or quote what it read from its pages. Results that you kept stay facts in your health record: the AI reads them as it reads any result, and says the document was deleted.
