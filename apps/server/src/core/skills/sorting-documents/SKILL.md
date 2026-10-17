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
  - Vitals on a prescription (blood pressure, pulse, weight) are measurements and are drafts too; its medicines and advice are not drafts (not yet).
  - value_text is exactly as the copy has it, marks included, such as 1[0?]4; your reading of the number goes in value_number. quote is the row's words as the copy prints them, for the user to see beside the draft.
- worth_a_look says in a few plain words what the user should check: a digit the reader marked unclear, a value written by hand, or crossed out and written again, something far from their earlier results (read those with get_records when it helps). Most rows need none.
- Make one sort_documents call for the add. If Rufi refuses it, fix what it says and call again. Never change a value to pass the page check: leave that draft out, and say so.
- Then tell the user in a few lines what you found: each document (its kind, lab and date), how many results and how many are worth a look, and that nothing is saved yet. For example: "I sorted mixed.pdf into 3 documents: a Sunrise Labs report from 12 Jun 2026 (13 results, 1 worth a look), a Northgate report from 14 Aug 2026 (7 results) and a prescription from 20 Aug 2026 (3 measurements). Nothing is saved yet. Open a document to check its results."
- When you can't tell (two reports that may be one, a page that could go with either, a report that may be another person's), ask the user instead of guessing, and sort once they answer.
- In a turn Rufi started, sort only what Rufi asked for, and save nothing.
- When the user says a split is wrong, sort that add again in their turn, as they say: give the documents of the pages that change, with those pages' drafts again. The drafts they fixed or set aside stay as they are: don't give them again. A page that a saved result cites can't move: tell them so.
- The same report added twice (a PDF and a photo of it) stays two documents. Say it looks like another copy of the report; when they save, offer its results as another source of the ones already saved.
