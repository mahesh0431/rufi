# Your record

Rufi shows your whole record: Overview at a glance, and a page for each kind of record. These pages only show your record. To change it, you talk to Rufi in the chat: click **Ask Rufi** on a row, and say what to change (see [Changing your record](chat.md#changing-your-record)).

## Overview

Overview is the first page you see. It has three parts, in this order:

1. **Needs you:** documents that wait for you, then follow-ups that are overdue, due now or coming up in the next 30 days:
   - a document that was read, with results not saved yet, says how many it has and how many to check;
   - a document with pages that couldn't be read says "couldn't be read · try a clearer scan". Add a clearer scan or photo, or click **Retry** on its page;
   - a document whose reading couldn't finish says so;
   - a follow-up says when it is due, for example "overdue, was due Sep 2026" (see [Follow-ups](follow-ups.md)).

   Click **Open** to go to the document's page (see [Documents](documents.md)), or to that follow-up on Follow-ups. Click **Ask Rufi** to put it in the chat's box and ask about it (see [Adding to a message](chat.md#adding-to-a-message)). A document read with nothing to save isn't here. When nothing waits, this part isn't shown.

2. **Your record:** one tile for each kind of record, with its count and a short summary. Click a tile to open that kind's page. A kind with nothing in it says **None yet**.
3. **Recent changes:** your last 5 saves and undos, newest first. Click one to see its receipt, the same as in the chat.

Rufi works out the tiles from your saved record, not with the AI. Each tile says what it counts:

| Tile                                 | What it says                                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Results                              | The latest report (or the latest results you typed in the chat), its date, how many results it has, and how many have a note from the lab |
| Medicines                            | How many you take now, with their names, and how many more are in your history (stopped, paused, completed)                               |
| Conditions                           | How many are ongoing, with their names                                                                                                    |
| Allergies                            | How many are active, with their names, or **None known** when you said so                                                                 |
| Prescriptions, Symptoms, Care events | The latest one and its date                                                                                                               |

A stopped medicine is still in your record: its tile counts it in your history, and its page shows it.

## The sidebar

Under **Overview**, **Your record** lists the kinds of record with their counts: Results, Medicines, Prescriptions, Conditions, Allergies, Symptoms and Care events. Click one to open its page.

## A kind's page

Each page shows the records that are current, newest first. As you scroll to the end, more load. You can also click **Show more**.

- **Results** are grouped the way the paper is. Results from one report are together: the lab, the date the sample was collected and how many results it has. When the report prints no date, it shows the latest date of its results, such as the one you gave ("Aug 2026"); a report with no dates at all goes under **No date**. A report always shows whole. Results you typed in the chat are grouped by their day, or by their month or year when that is all you said ("May 2026"). Rufi never makes up a day. Results with no date come last, under **No date**.
- A result shows its test, its value and unit (in one column, so values line up), the lab's range, and the lab's note and context, as printed. A date shows at the precision known, with its time when there is one. "Amended" means that the lab corrected the result. When a result's own date differs from its report's date, the row shows it.
- **Other kinds** show one row for each record, newest first by its date: when a medicine started, when a symptom began. Records with no date come last.
- **Allergies** also show "No known allergies" when you said so, with the day you said it.

A removed record isn't shown, and neither is a result that an amended result replaced. Both stay in the history.

If Rufi can't show a stored record, its row says **Can't show this row**. The rest of the page still shows.

## Open a row

Click a record's name to open it in place. Click again to close it.

- **Sources:** where it came from. For a document page, click **Open** to go to the document. For something you said in the chat, your words are shown.
- **History:** each save that changed it, oldest first, with its date and time. A change shows what changed, before and after, such as "value 22 → 24". A removal has its own line. A record saved before Rufi kept its history has none.
- **Replaces** or **Replaced by:** for an amended result, the earlier version it replaces, which is kept. For a replaced result, the result that replaced it.
- For a result, when it was measured and when it entered Rufi. These are two different dates.
- For a result, **over time:** every current value of that test in that unit, oldest first, then the values with no date. A corrected or removed value isn't a second value here: it is in that row's history. A value in another unit has its own table.

## Ask Rufi about a row

Point at a row and click **Ask Rufi**. The record goes in the chat's box as a chip, and you stay on the page: the chat bar shows what you added (see [The chat bar](chat.md#the-chat-bar)). Add more rows the same way if you like. Then click the bar, say what you want, for example "this stopped last week", and send. The AI changes your record only after you say yes, and the chat shows a receipt.

On Results, a report's heading has its own **Ask Rufi**: it adds that report's results as one chip, and the AI reads exactly those.

## When your record changes

When a save or an undo happens in the chat, Overview, the sidebar's counts and the open pages show it at once, in every Rufi window and tab. When a reading of a document ends or fails, **Needs you** shows it. When you come back to a Rufi window, Overview reads your record again. While it shows, it also reads again each minute, so Needs you shows the new day after midnight.
