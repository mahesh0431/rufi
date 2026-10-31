# Your health record

Rufi shows your whole health record: Overview at a glance, and a page for each kind of record. Results have two pages: **Lab results** and **Measurements**. These pages only show your health record. To change it, you talk to Rufi in the chat: click **Ask Rufi** on a row, and say what to change (see [Changing your health record](chat.md#changing-your-health-record)).

## Overview

Overview is the first page you see. It has three parts, in this order:

1. **Needs you:** documents that wait for you, then follow-ups that are overdue, due now or coming up in the next 30 days:
   - a document that was read, with results not saved yet, says how many it has and how many to check;
   - a document with pages that couldn't be read says "couldn't be read · try a clearer scan". Add a clearer scan or photo, or click **Retry** on its page;
   - a document whose reading couldn't finish says so;
   - a follow-up says when it is due, for example "overdue, was due Sep 2026" (see [Follow-ups](follow-ups.md)).

   Click **Open** to go to the document's page (see [Documents](documents.md)), or to that follow-up on Follow-ups. Click **Ask Rufi** to put it in the chat's box and ask about it (see [Adding to a message](chat.md#adding-to-a-message)). A document read with nothing to save isn't here. When nothing waits, this part isn't shown.

2. **Health record:** a tile for each of its pages that has something in it, with its count and a short summary. Click a tile to open that page. The pages with nothing in them are on one line under the tiles, **Nothing yet:** and their names. Click a name to open that page. When a page gets its first record, it gets its tile.
3. **Recent changes:** your last 5 saves and undos, newest first, also the changes you made to your profile on its page or in Settings. Click one to see its receipt, the same as in the chat.

Rufi works out the tiles from your saved health record, not with the AI. Each tile says what it counts:

| Tile                          | What it says                                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lab results                   | How many tests it lists, then the latest report (or the latest lab results you typed in the chat), its date, how many results it has, and how many have a note from the lab |
| Measurements                  | The latest day with measurements, what was measured that day, and the date                                                                                                  |
| Medicines                     | How many you take now, with their names, and how many more are in your history (stopped, paused, completed)                                                                 |
| Conditions                    | How many are ongoing, with their names                                                                                                                                      |
| Allergies                     | How many are active, with their names, or **None known** when you said so                                                                                                   |
| Visits, Symptoms, Care events | The latest one and its date, for example "Latest: Dr A. Fictional · Lakeview Family Clinic · 20 Aug 2026"                                                                   |

A stopped medicine is still in your health record: its tile counts it in your history, and its page shows it.

## The sidebar

Under **Overview**, **Health record** lists its pages with their counts (on Lab results, your tests): Lab results, Measurements, Medicines, Visits, Conditions, Allergies, Symptoms and Care events (procedures and immunisations). Click one to open its page. A page with nothing in it yet shows Rufi and "Nothing here yet."; click **Ask Rufi** there to open your chat.

## Lab results and Measurements

Each result is a lab result or a measurement. A **lab result** is a test of a sample, such as blood or urine. A **measurement** is a reading of the body, such as blood pressure, pulse, weight, height, temperature or SpO2. The AI chooses which with you when it saves a result, from a document or from what you typed; Rufi doesn't work it out from the test's name. A result that the lab amended keeps the page of the result it replaces, unless you say otherwise.

To move a result to the other page, tell the AI, for example "this weight is a measurement". As for every change, it asks first, and the chat shows a receipt. The move is in the result's history, and "undo that" moves it back. A result read from a document can move too: only its page changes, not what the document printed.

A lab test and a measurement of the same name are kept apart: each has its own values over time.

Results saved before Rufi had the two pages are on Lab results. Move any measurement among them in the chat.

### Your tests

Each result is in one of your tests, such as Creatinine, Blood count items like Haemoglobin, or Blood pressure. A test keeps the values of one thing measured from every lab together, whatever each lab called it: "S. Creatinine", "Creatinine, serum" and "CREA" can all be Creatinine. A urine creatinine is a test of its own.

- **Lab results lists your tests**, each once with its latest value (see [A page](#a-page)), and each test has its own page with every value (see [A test](#a-test)).
- **The AI chooses the test** when it saves a result, and tells you which test a result joins when the lab named it differently, and which tests are new. It asks when it isn't sure. Each test has a name and a section, such as Kidney, in the AI's words.
- **Each test has a unit**, such as mg/dL. The AI also saves each result's number in that unit: the printed number when the units mean the same (mg/dl and mg/dL), or converted, for example 97 µmol/L as 1.1 mg/dL. When it can't compare, it saves none. What the lab printed always stays as it came.
- **To fix a test, tell the AI**, for example "these two are the same test", "the urine one isn't creatinine" or "call it Serum creatinine". As for every change, it asks first, and the chat shows a receipt. "Undo that" puts it back.
- A test you no longer have results in isn't on Lab results. It stays, and the AI can use it again. Results saved before Rufi had tests are in one test for each name and unit the lab printed: ask the AI to join any that are the same.

An old link to a result opens it on its page now.

## Your profile

Your health record keeps a short profile of you: your name, your birth date, your sex for lab ranges, your blood group and your height. Each one but your name is **Not set** until you give it, and blood group and height can stay empty.

- **Name** is what Rufi calls you, as in the sidebar. You can change it, but not leave it empty.
- **Birth date** can be a year, a month and year, or a full date: give only what you want to share. Rufi keeps it with your words, such as "March 1990", and works out your age from it. A year alone leaves your age one year open.
- **Sex for lab ranges** is Female or Male. It is only for choosing lab ranges, such as for haemoglobin or ferritin, which differ for women and men. It isn't a question about gender.
- **Blood group** is A+, A−, B+, B−, AB+, AB−, O+ or O−.
- **Height** is a number and its unit, cm or in, as you give it. It is your profile's own value: a height on a report or in your measurements stays a measurement, and changes nothing here.

Click your name at the top of the sidebar to open your profile. It shows each value, your age today ("36 years old today", or "about 36" when you gave only a year), and its **History**: each change, newest first, with when it was made, what changed (old → new) and where: **in the chat**, **in the welcome**, **on this page** or **in Settings**.

You can change your profile in three places:

- **On its page:** click **Edit**, change a field, then click **Done**.
- **In Settings › Profile:** the same fields.
- **In the chat:** tell the AI, for example "I was born in March 1990" or "my blood group is B+". As for every change, it asks first, and the chat shows a receipt.

On the page and in Settings, a field saves on its own once it is complete: a choice when you choose it, a birth date or a height when you leave it. Only that field is saved. Empty a birth date, a blood group or a height to clear it. If a change can't be saved, what you entered or chose stays, with why and **Retry**. On the page, **Done** closes the form once every change is saved. A change made there has no receipt in the chat: it is in your profile's history and in Overview's **Recent changes**. The AI sees it too, so "undo my last profile change" in the chat puts the earlier value back, after your yes. Your profile is never removed.

The AI reads your profile with your health record, and uses your age and sex to choose a range when a report prints none (see [Asking about your health record](chat.md#asking-about-your-health-record)).

A data folder from before profiles keeps your name and has every other value **Not set**. The AI asks when it needs one.

## A page

Each page shows the records that are current, newest first. As you scroll to the end, more load. You can also click **Show more**. Lab results shows all your tests at once.

- **Lab results** lists your tests, each once, under its section, such as Kidney or Thyroid, in the AI's words. Sections are in name order, and tests with no section come last, under **Other tests**. A test's row shows its name, how many values it has, and its latest value as the lab printed it. The latest is the one whose sample was taken last, so a report from an earlier year that you add today doesn't change it; a value with no date counts only when the test has no dated one. Click a test's name to open its page (see [A test](#a-test)). A report itself, whole, is on its document's page (see [Documents](documents.md)).
- **Measurements** are grouped by the day they were taken, newest first, with how many there are that day, for example "20 Sep 2026 · 2 measurements". A measurement dated only by month or year has its own group ("Aug 2026"). The measurements of a report, such as the blood pressure from a visit, are here too, under the day each was taken, not with the report's lab results. Measurements with no date come last, under **No date**.
- A result's row shows its value and unit (in one column, so values line up), a small line of its latest values, the lab's range, the lab's note and context, as printed, and its date. The small line shows only when there are two or more values with a date and a number, and it ends at that row's value. A date shows at the precision known, with its time when there is one. "Amended" means that the lab corrected the result.
- **Other kinds** show one row for each record, newest first by its date: when a medicine started, when a symptom began. Records with no date come last.
- **Allergies** also show "No known allergies" when you said so, with the day you said it.
- **Visits** show each visit to a doctor: its doctor and place, why you went, how many records came from it, the kind of visit in your words (for example, Clinic, Dental or Lab visit) and its date; a hospital stay shows from admission to discharge. Click a visit's name to open its page (see [A visit](#a-visit)).

A removed record isn't shown, and neither is a result that an amended result replaced. Both stay in the history.

If Rufi can't show a stored record, its row says **Can't show this row**. The rest of the page still shows.

## A visit

A visit is one time you saw a doctor: at a clinic, online (a video or phone call), at home, or a stay in hospital. It keeps what the doctor wrote or said, as written, also the medicines you didn't take. You save one in the chat: send its prescription or discharge summary, or tell the AI about the visit (see [A visit's paper](documents.md#a-visits-paper)).

A visit's page shows:

- its doctor, place, setting and date, with **Ask Rufi**;
- **The doctor's words**, as the paper has them, with its headings, such as Diagnosis, Rx and Advice. For a visit you told the AI about, your words;
- **From this visit**: the records saved from it, such as a medicine you take, a condition or a follow-up, each with **Open**. A medicine the doctor proposed that you don't take is only in the doctor's words;
- its **Sources** (the paper's page, or your message) and its **History**, as any record.

A record saved from a visit shows the visit in its sources. One record can come from several visits, such as a condition seen at each one.

## A test

A test's page shows:

- its name, its section and its unit, with **Ask Rufi**;
- every current value, newest first by when its sample was taken, then those with no date: the date, the value and unit as the lab printed them, its name as the lab printed it, the lab (or **Typed in the chat**), the lab's range, and the lab's note and context. When the AI saved the value's number in the test's unit as another number, it shows under the value, for example "97 µmol/L" and "= 1.1 mg/dL";
- the test's own **Sources** and **History**: when it was added, and each time it was renamed or given another section or unit.

Click a value's date to open it in place: its sources, its history and, for an amended result, **Replaces** (see [Open a row](#open-a-row)). A link to a lab result, such as a follow-up's **About**, opens its test's page with that value open.

## Open a row

Click a record's name to open it in place. Click again to close it.

- **Sources:** where it came from. For a document page, click **Open** to go to the document. For a visit, such as **Visit · Dr A. Fictional · Lakeview Family Clinic · 20 Aug 2026**, click **Open** to go to the visit's page; a visit you removed says **Visit removed**. A page of a document you deleted says **Document deleted (Sunrise Labs August.pdf, page 2)**, with nothing to open. A result you kept when you deleted its document stays as it was: only its file is gone. For something you said in the chat, your words are shown.
- **History:** each save that changed it, oldest first, with its date and time. A change shows what changed, before and after, such as "value 22 → 24". A removal has its own line, and so has **Put back**, when a removed record came back. A record saved before Rufi kept its history has none.
- **Replaces** or **Replaced by:** for an amended result, the earlier version it replaces, which is kept. For a replaced result, the result that replaced it.
- For a result, when it was measured and when it entered Rufi. These are two different dates.
- For a measurement, **over time:** every current value of that test in that unit on Measurements, as a line and as a table. A corrected or removed value isn't a second value here: it is in that row's history. A value in another unit has its own line and table.
  - The line puts each value at its date, oldest on the left; the newest value is a filled dot. One value is a single dot. A blood pressure has two lines: the second number is dashed.
  - The newest value's range is written at the top right as the lab printed it, for example "Lab range 30 - 400". The line fits your values, so a wide range doesn't flatten it.
  - A value the lab flagged, such as "High" or "Low", has a ring around it, on the small line too. Rufi adds no flag of its own and uses no colours for high or low: the lab's flag is in the table, in words.
  - Values with no date, or with no number (such as "Negative"), aren't on the line. The table shows every value: oldest first, then those with no date. The lab's range and note columns show only when a value has them.

## Ask Rufi about a row

Point at a row and click **Ask Rufi**, Rufi's face with a blue + at the row's end. The record goes in the chat's box as a chip, and you stay on the page: the chat bar shows what you added (see [The chat bar](chat.md#the-chat-bar)). Add more rows the same way if you like. Then click the bar, say what you want, for example "this stopped last week", and send. The AI changes your health record only after you say yes, and the chat shows a receipt.

On Lab results and on a test's page, **Ask Rufi** adds the test as one chip, such as "Creatinine", and the AI reads its values. To ask about a whole report, add its document (see [Adding to a message](chat.md#adding-to-a-message)).

## When your health record changes

When a save or an undo happens in the chat, Overview, the sidebar's counts and the open pages show it at once, in every Rufi window and tab. When a reading of a document ends or fails, **Needs you** shows it. When you come back to a Rufi window, Overview reads your health record again. While it shows, it also reads again each minute, so Needs you shows the new day after midnight.
