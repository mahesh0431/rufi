---
name: sorting-documents
description: When the user sends files (Rufi's note names those not read yet), a reader's reading comes back, or the user says a document was sorted wrong ("pages 3 and 4 are one letter"). How to have files read by readers, split an add into documents and draft its results from the page copies.
---

# Sorting documents

A file is read, then sorted. A reader, an agent you start, copies each page as printed, with its marks where something was unclear, and decides nothing. You decide what the pages are, and draft their results; the user checks them and saves them later.

## Having files read

Rufi's note names the files the user sent that aren't read yet: each document's id and the pages to read. Some ways to go about it:

- Before you start a reader, look at the document with get_documents: its agent is the reader set on it, and its status says "reading" while that agent is at work and hasn't saved. agent_status, and read_agent when you need more, show how the agent is getting on. If it is still reading and getting on, tell the user it is still being read, and start nothing new. If it is stuck or failed, stop it if it still runs, then start a fresh reader. If there is none, start one.
- Start a reader for each file with start_agent: a title such as "Reading report.pdf", and a task that names the document's id and the pages to read, and asks it to use the reading-documents skill.
- A reader that is still at work can take another file too: send it the document and pages with send_agent.
- Then set the reader on its documents with set_reader, with the agent's id from start_agent's answer: the user sees the document as Reading while it works, and you see its agent the next time you look.
- Before you start readers, write your plan in your to-do list: the readers to start, and setting each on its documents. After a restart ("Rufi stopped suddenly (restart). Please continue."), the list shows what is still to do, such as a reader you started and haven't set on its documents yet.
- Choose each reader's model and effort (start_agent names them). A clear printed PDF may need less than a blurred photo, handwriting or a long table; usage shows how much of the plan is left.
- A long document can go to several readers, each with some of its pages.
- While readers work, you can tell the user what is being read and end your turn: each reader's result wakes you.
- When a reading fails or stops, you can start a reader again for the pages it didn't save, on the same model or another, or tell the user what happened and let them choose.
- Once a file's reading is saved, sort it. You can sort each file as its reading comes back, or wait for the others and sort them together: how much to sort at once is your call.

## Sorting what was read

When a message brings documents that are read and not sorted, sort them (one sort_documents call for each add), then answer what the user wrote.

- Read the copies with get_documents (document and copies: true), to the end (read on with next). When a copy is unclear or a mark needs a closer look, look at the page itself (document and page). Each copy names its reading; each draft names the reading of the copy you drafted it from.
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
- Make one sort_documents call for what you sort of the add now; pages you leave out wait for a later call. If Rufi refuses it, fix what it says and call again.
- Then tell the user in a few lines what you found, beside your answer to what they wrote, or alone when they wrote nothing: each document (its kind, lab and date), how many results and how many are worth a look, and that nothing is saved yet. For example: "I sorted mixed.pdf into 3 documents: a Sunrise Labs report from 12 Jun 2026 (13 results, 1 worth a look), a Northgate report from 14 Aug 2026 (7 results) and a prescription from 20 Aug 2026 (3 measurements). Nothing is saved yet. You can check their results on [the Sunrise Labs report](rufi:/documents/…), [the Northgate report](rufi:/documents/…) and [the prescription](rufi:/documents/…)." When a document is a paper from a visit (a prescription, a discharge summary), also propose its Visit as the visits skill says: read get_overview, say what the paper holds and which of its medicines are already in the user's record, and ask whether they take the others. Save nothing in this turn: the user answers in theirs.
- When you can't tell (two reports that may be one, a page that could go with either, a report that may be another person's), ask the user instead of guessing, and sort once they answer.
- Save nothing while you sort: the drafts wait for the user. A page read again (the user's Retry) can join the document it belongs to as that document is (its id, no kind, date, lab or number), or be a new document of its own (no id) when it is another paper.
- When the user says a split is wrong, sort that add again in their turn, as they say: give the documents of the pages that change, with those pages' drafts again. The drafts they fixed, set aside or saved stay as they are: don't give them again. A page that a saved result cites can't move: tell them so.
- The same report added twice (a PDF and a photo of it) stays two documents. Say it looks like another copy of the report; when they save, offer its results as another source of the ones already saved.
