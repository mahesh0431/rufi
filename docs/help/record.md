# Your health record

Rufi shows your whole health record: Overview at a glance, and a page for each kind of record. Results have two pages: **Lab results** and **Measurements**. These pages only show your health record. To change it, you talk to Rufi in the chat: click **Ask Rufi** on a row, and say what to change (see [Changing your health record](chat.md#changing-your-health-record)).

## Overview

Overview is the first page you see. It has three parts, in this order:

1. **Needs you:** the questions Rufi asked you (see [Questions Rufi asked](#questions-rufi-asked)), then documents that wait for you, then follow-ups that are overdue, due now or coming up in the next 30 days:
   - a document that was read, with results not saved yet, says how many it has and how many to check;
   - a document with pages that couldn't be read says "couldn't be read · try a clearer scan". Add a clearer scan or photo, or click **Retry** on its page;
   - a document whose reading couldn't finish says so;
   - a follow-up says when it is due, for example "overdue, was due Sep 2026" (see [Follow-ups](follow-ups.md)).

   Click **Open** to go to the document's page (see [Documents](documents.md)), or to that follow-up on Follow-ups. Click **Ask Rufi** to put it in the chat's box and ask about it (see [Adding to a message](chat.md#adding-to-a-message)). A document read with nothing to save isn't here. Under them, quiet lines show the AI's unfinished tasks, what you put off for later, and what was closed this week. When nothing waits, this part isn't shown.

2. **Health record:** one tile for each of its pages, with its count and a short summary. Click a tile to open that page. A page with nothing in it says **None yet**.
3. **Recent changes:** your last 5 saves and undos, newest first. Click one to see its receipt, the same as in the chat.

Rufi works out the tiles from your saved health record, not with the AI. Each tile says what it counts:

| Tile                                 | What it says                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Lab results                          | The latest report (or the latest lab results you typed in the chat), its date, how many results it has, and how many have a note from the lab |
| Measurements                         | The latest day with measurements, what was measured that day, and the date                                                                    |
| Medicines                            | How many you take now, with their names, and how many more are in your history (stopped, paused, completed)                                   |
| Conditions                           | How many are ongoing, with their names                                                                                                        |
| Allergies                            | How many are active, with their names, or **None known** when you said so                                                                     |
| Prescriptions, Symptoms, Care events | The latest one and its date                                                                                                                   |

A stopped medicine is still in your health record: its tile counts it in your history, and its page shows it.

## Questions Rufi asked

When the AI asks you to decide something that matters later, such as "Save HbA1c 6.1 % from Sunrise Labs, 12 Mar 2026?", Rufi keeps the question. It waits in **Needs you** under **Rufi asked**, newest first, with the day it was asked, until it is answered or dropped. It stays also after many more messages, a restart of Rufi, or a change of model. A long question shows two lines: click **More** to read all of it.

Each question has three buttons:

- **Answer** puts the question in the chat's box as a chip. Type your answer and send it. The chip only tells the AI which question you mean: it is never your yes. The AI reads the question again, with what it is about as it is now, before it acts (see [Questions and tasks Rufi keeps](chat.md#questions-and-tasks-rufi-keeps)).
- **Later** hides the question for 7 days. It comes back by itself at the start of that day.
- **Drop** closes the question without an answer.

When you answer in the chat, the AI closes the question itself: "Saved" when a save answered it, or with its reason. When you say "not now", it puts the question on Later.

Under the questions, quiet lines open short lists:

- **Rufi has 1 unfinished task:** work the AI agreed to do for you that takes more than one reply, such as comparing your last three lipid panels. **Continue** puts the task in the chat's box: send a message to go on. **Drop** closes it. A task never starts by itself.
- **Later (2):** what you put off, with the day each comes back. **Bring back** shows it again now.
- **Closed this week (3):** what was closed in the last 7 days, with how it closed, for example "Saved" or "Dropped: not wanted". **Reopen** opens it again. Reopening never saves anything: the AI asks you again.

These buttons change only Rufi's list of open work, never your health record. When another Rufi window changed a question first, Rufi says so, for example "… changed in another window. It is dropped now.", and the row shows it as it is now.

## The sidebar

Under **Overview**, **Health record** lists its pages with their counts: Lab results, Measurements, Medicines, Prescriptions, Conditions, Allergies, Symptoms and Care events. Click one to open its page.

## Lab results and Measurements

Each result is a lab result or a measurement. A **lab result** is a test of a sample, such as blood or urine. A **measurement** is a reading of the body, such as blood pressure, pulse, weight, height, temperature or SpO2. The AI chooses which with you when it saves a result, from a document or from what you typed; Rufi doesn't work it out from the test's name. A result that the lab amended keeps the page of the result it replaces, unless you say otherwise.

To move a result to the other page, tell the AI, for example "this weight is a measurement". As for every change, it asks first, and the chat shows a receipt. The move is in the result's history, and "undo that" moves it back. A result read from a document can move too: only its page changes, not what the document printed.

A lab test and a measurement of the same name are kept apart: each has its own values over time.

Results saved before Rufi had the two pages are on Lab results. Move any measurement among them in the chat.

An old link to a result opens it on its page now.

## A page

Each page shows the records that are current, newest first. As you scroll to the end, more load. You can also click **Show more**.

- **Lab results** are grouped the way the paper is. Lab results from one report are together: the lab, the date the sample was collected and how many results it has. When the report prints no date, it shows the latest date of its results, such as the one you gave ("Aug 2026"); a report with no dates at all goes under **No date**. A report's lab results always show whole. Lab results you typed in the chat are grouped by their day, or by their month or year when that is all you said ("May 2026"). Rufi never makes up a day. Lab results with no date come last, under **No date**.
- **Measurements** are grouped by the day they were taken, newest first, with how many there are that day, for example "20 Sep 2026 · 2 measurements". A measurement dated only by month or year has its own group ("Aug 2026"). The measurements of a report, such as the blood pressure from a visit, are here too, under the day each was taken, not with the report's lab results. Measurements with no date come last, under **No date**.
- A result shows its test, its value and unit (in one column, so values line up), the lab's range, and the lab's note and context, as printed. A date shows at the precision known, with its time when there is one. "Amended" means that the lab corrected the result. When a result's own date differs from its report's date, the row shows it.
- **Other kinds** show one row for each record, newest first by its date: when a medicine started, when a symptom began. Records with no date come last.
- **Allergies** also show "No known allergies" when you said so, with the day you said it.

A removed record isn't shown, and neither is a result that an amended result replaced. Both stay in the history.

If Rufi can't show a stored record, its row says **Can't show this row**. The rest of the page still shows.

## Open a row

Click a record's name to open it in place. Click again to close it.

- **Sources:** where it came from. For a document page, click **Open** to go to the document. A page of a document you deleted says **Document deleted (Sunrise Labs August.pdf, page 2)**, with nothing to open. A result you kept when you deleted its document stays as it was: only its file is gone. For something you said in the chat, your words are shown.
- **History:** each save that changed it, oldest first, with its date and time. A change shows what changed, before and after, such as "value 22 → 24". A removal has its own line. A record saved before Rufi kept its history has none.
- **Replaces** or **Replaced by:** for an amended result, the earlier version it replaces, which is kept. For a replaced result, the result that replaced it.
- For a result, when it was measured and when it entered Rufi. These are two different dates.
- For a result, **over time:** every current value of that test in that unit on that page, oldest first, then the values with no date. A corrected or removed value isn't a second value here: it is in that row's history. A value in another unit has its own table. The lab's range and note columns show only when a value has them.

## Ask Rufi about a row

Point at a row and click **Ask Rufi**. The record goes in the chat's box as a chip, and you stay on the page: the chat bar shows what you added (see [The chat bar](chat.md#the-chat-bar)). Add more rows the same way if you like. Then click the bar, say what you want, for example "this stopped last week", and send. The AI changes your health record only after you say yes, and the chat shows a receipt.

On Lab results, a report's heading has its own **Ask Rufi**: it adds the whole report as one chip, with any measurements it printed, and the AI reads exactly that report's results. A day of measurements has no such button: add its rows one by one.

## When your health record changes

When a save or an undo happens in the chat, Overview, the sidebar's counts and the open pages show it at once, in every Rufi window and tab. When a reading of a document ends or fails, or a question or task changes, **Needs you** shows it. When you come back to a Rufi window, Overview reads your health record again. While it shows, it also reads again each minute, so Needs you shows the new day after midnight.
