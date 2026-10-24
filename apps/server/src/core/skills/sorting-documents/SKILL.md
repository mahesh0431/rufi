---
name: sorting-documents
description: When Rufi asks you to sort what the user added (a reading finished), or the user says a document was sorted wrong ("pages 3 and 4 are one letter"). How to split an add into documents and draft its results from the reader's page copies.
---

# Sorting documents

The reader copied each page as printed, with its marks where something was unclear, and decided nothing. You decide what the pages are, and draft their results; the user checks them and saves them later.

- Read the copies with get_documents (document and copies: true), to the end (read on with next). When a copy is unclear or a mark needs a closer look, look at the page itself (document and page).
- Split the add into documents, one per report or paper, each with its kind, its date and, for a report, its lab and report number, as printed. Some ways to tell:
  - A report's pages go together, also a page that prints no lab or date (a table that goes on). A page that starts again at "Page 1", another lab, another report number or another collection date is another document.
  - A prescription, a letter or a bill is a document of its own.
  - A report's date is its collection date; a prescription's or a letter's is its own date.
- Draft every current result and measurement of each document, as its copy prints it. Some tips:
  - A column of earlier results ("Previous", "Last time") is not a draft: only the current values are.
  - Each draft's date is its own report's collection date, or for a measurement the visit's, with the words printed beside it. When day and month could be either way round, leave iso out.
  - Vitals on a prescription (blood pressure, pulse, weight) are measurements and are drafts too; its medicines and advice are not drafts: they go in its Visit, which you propose when you tell the user what you found (the visits skill).
  - value_text is the value as the copy prints it, as it would be saved. Write characters, not the copy's HTML or Markdown: "<0.5", not "&lt;0.5" or "\<0.5"; "13.2", not "**13.2**". Where the reader marked a digit unclear, such as 1[0?]4, give your reading (104) and say why in worth_a_look. quote is the row's words as printed, for the user to see beside the draft: its cells separated by " | ", without the copy's HTML or Markdown, the reader's marks kept. For a row the copy has as `<tr><td>TSH</td><td><s>5.3 H</s> [handwritten: 5.8]</td><td>mIU/L</td></tr>`, write `TSH | ~~5.3 H~~ [handwritten: 5.8] | mIU/L`.
- worth_a_look says in a few plain words what the user should check: a digit the reader marked unclear, a value written by hand, or crossed out and written again, something far from their earlier results (read those with get_records when it helps). Most rows need none.
- Name each document by its id from get_documents: the add's own id for its first document, and a split document's own id for it. Leave id out for a new document. A named document keeps what you leave out (its kind, date, lab and number), so give only what you change.
- Make one sort_documents call for the add. If Rufi refuses it, fix what it says and call again.
- Then tell the user in a few lines what you found: each document (its kind, lab and date), how many results and how many are worth a look, and that nothing is saved yet. For example: "I sorted mixed.pdf into 3 documents: a Sunrise Labs report from 12 Jun 2026 (13 results, 1 worth a look), a Northgate report from 14 Aug 2026 (7 results) and a prescription from 20 Aug 2026 (3 measurements). Nothing is saved yet. Open a document to check its results."
- When you can't tell (two reports that may be one, a page that could go with either, a report that may be another person's), ask the user instead of guessing, and sort once they answer.
- In a turn Rufi started, sort only what Rufi asked for, and save nothing. A page read again joins the document it belongs to as that document is (its id, no kind, date, lab or number), or is a new document of its own (no id) when it is another paper.
- When the user says a split is wrong, sort that add again in their turn, as they say: give the documents of the pages that change, with those pages' drafts again. The drafts they fixed, set aside or saved stay as they are: don't give them again. A page that a saved result cites can't move: tell them so.
- The same report added twice (a PDF and a photo of it) stays two documents. Say it looks like another copy of the report; when they save, offer its results as another source of the ones already saved.
