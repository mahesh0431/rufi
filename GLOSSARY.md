# Rufi glossary

Your health record on your Mac: you keep your record, and an AI helps by reading it and saving the changes you agree to in the chat. The record can hold more than one person; the screens for that come later. The same words are used on screen, in the docs, in the AI's instructions and in the code.

Some words are for features still being built, such as follow-ups and visit briefs. The help pages in [`docs/help/`](docs/help/index.md) say what works today.

## People

**You (the user)**:
The one person using Rufi on this Mac, keeping their own health record (and later, other people's too). Screens and help say "you" or use your name; the AI's instructions and code say "the user".
_Avoid_: keeper, owner, admin, caregiver

**Person**:
Someone whose health record Rufi keeps; you are often one of them.
_Avoid_: patient, profile, member

## The record

**Record**:
Everything Rufi holds as true about one person: what the user said yes to in the chat, and what came from their documents. Each record (a medicine use, prescription, symptom, condition, allergy, result, care event, "none known" statement or follow-up) keeps its source and its history; removing one takes it out of the current record and keeps its history.
_Avoid_: chart, file, history

**Health record**:
What people see for the record: the sidebar's heading, Overview and the help say "your health record". The AI says it too. Tables, tools and code keep "record".
_Avoid_: your record (on screen), health file, chart

**Document**:
What the user added for a person in one go: one PDF, or photos added together, such as a lab report photographed page by page. Its pages are the PDF's pages or the photos, in order. Rufi keeps each original file exactly as it came, and the same content only once per person, until the user deletes the document.
_Avoid_: upload, attachment

**Reading**:
Rufi reading one document in the background with its reader, as soon as you add it: one page at a time, then a line in the chat when it ends. Only a reading that finished makes draft items; one that stopped continues with **Retry**, or by itself after Rufi starts again.
_Avoid_: import, scan, parsing, extraction

**Reader**:
The AI that does a reading: a separate AI that Rufi starts for one document, with only two tools (look at a page, save what the page says) and no access to your record, chat, files or the internet. It copies what is printed; it never judges or saves to the record.
_Avoid_: parser, OCR, extractor

**Draft item**:
One thing a reading found, such as a result, kept exactly as printed and waiting for you: not part of your record, so it counts in no answer, Overview or trend until you save it. The reader's own values are kept beside any change. It points to its document and page, and may be marked unsure. It waits until it is saved (new, as another source of a saved result, or as a correction) or dismissed; a dismissed item is never saved.
_Avoid_: pending result, unconfirmed record, extracted row

**Report**:
A lab or clinic report read from a document: who issued it, its printed report number, and when the sample was collected. When all three match, saved results from different documents belong to the same report for that person. If any is missing, reports stay within their document.
_Avoid_: lab sheet, test report

**Result**:
One lab test or measurement, kept exactly as reported or entered: name, value, unit, reference range, the lab's own flag, method or context, and when it was measured at the precision known. Every result has a **category**: it is a lab result or a measurement.
_Avoid_: reading, lab value

**Category**:
Whether a result is a lab result or a measurement, which decides the page it shows on. The AI chooses it with the user when it saves, never from the test's name or from having a report; an amended result keeps the category of the one it replaces unless the user agrees to another. The user can change it in the chat ("that's a measurement"): the same result moves, with a receipt. Results saved before Rufi had categories count as lab results.
_Avoid_: type, kind (a kind is a kind of record)

**Lab result**:
A result of the category lab: a test of a sample, such as blood or urine, from a lab or a clinic, also when the user types it in. The **Lab results** page groups them by report, a report's lab results whole, and the typed ones by day.
_Avoid_: lab value, test result

**Measurement**:
A result of the category measurement: a reading of the body, such as blood pressure, pulse, weight, height, temperature or SpO2, typed in or read from a document. The **Measurements** page groups them by the day they were taken, at the precision known. Its date is when it was taken, never a lab's collection date.
_Avoid_: vital, vitals, reading

**As printed**:
Exactly what the source shows, kept unchanged. A printed "High" is the lab's word, never Rufi's judgement.
_Avoid_: normalised, cleaned

**Amended result**:
A result the lab issued again, replacing an earlier version; its value or any other reported detail may differ, and the earlier version is kept.
_Avoid_: corrected, updated, overwritten

**Source**:
Where a saved record came from: the user's own message in the chat, or a document and its page. A record can have several, such as a result the user told the AI and then added in a lab report; the same result from another copy is another source, not another result. Undo of another source takes only that source off. A date said in words ("last Monday") counts from when the source message was sent.
_Avoid_: origin, provenance, attachment

## Changes

**Save**:
One change to the record that the user agreed to in the chat: the AI's call to save it, then every record it changed, each with its before and after, and its receipt, all together or none. The same call again saves nothing new.
_Avoid_: change set, batch, transaction, commit

**Receipt**:
What Rufi adds to the chat for each save: "Saved", then one line for each change, written from what was saved, never from the AI's words. A save of a document's draft items starts with a summary (how many new, more sources and corrections), and its lines say each one's page.
_Avoid_: toast, success message, confirmation

**Undo**:
Saving the reverse of an earlier save, by chat: the user says "undo that", the AI says what will change back and anything that changed since, and saves it after the user says yes. The earlier save stays in the history.
_Avoid_: revert, rollback

**Remove**:
Taking a record out of the current record, by a save in the chat: it stays in the history, shows as removed, and "undo that" puts it back. A record is never deleted.
_Avoid_: delete (for a record), erase

**Put back**:
Bringing a removed record back into the current record, by a save in the chat, usually to undo a removal. Its receipt line and its history say "Put back".
_Avoid_: restore (that is for a backup), recover

**Delete**:
Taking a document out of Rufi, on its page, not in the chat: its original, the pages Rufi drew from it, the reader's work, its readings and its draft items go. Its name and page numbers stay, so the history, sources and chips that point at it say "document deleted". It can't be undone. When saved records come from the document, the user chooses: **Delete file** keeps them, and **Delete file and results** opens the chat, where the AI goes through them and removes each one on the user's yes. The delete itself never changes the record. Rufi's backups keep the document until they age out.
_Avoid_: remove (for a document), erase, purge

**Needs you**:
The top of a person's Overview: what is waiting for the user, such as a document read and not saved, one that couldn't be read, or a follow-up that is overdue, due now or coming up in the next 30 days. It hides when nothing waits.
_Avoid_: inbox, notifications, tasks

**Tile**:
One page of the health record on the Overview, such as Lab results or Medicines: its count of current records and a short summary that says what it counts, such as how many medicines you take now and how many are in your history. Rufi works it out from the saved record, never with the AI. It opens that page.
_Avoid_: card, widget

## The chat

**Chat**:
Each person's one conversation with Rufi's AI, kept by Rufi and made with the person. It shows in three sizes (the chat bar, the chat panel and the chat page) with the same box. To talk about something new, the user just says so.
_Avoid_: conversation, thread, session

**Chat bar**:
The box at the bottom right of the pages where you read your health (Overview, the record's pages, Follow-ups, Documents, a document's page, a visit brief), a pill with the model and effort and Send: the person's chat, the same in every browser tab. The pages leave room for it, so it covers nothing. It is one line, always the same size: what **Ask Rufi** added (the first chip's name and how many more), then the start of the draft, or a reason for the moment; a click opens the chat panel. While a reply runs, it says "Rufi is answering" with Stop. Help and Settings reach the chat with **Chat with Rufi** in the sidebar.
_Avoid_: composer, input

**Chat panel**:
The chat opened over the page from the chat bar (or with ⌘J), always the same size, with a thin top bar: – back to the bar, and the arrows to the chat page. –, Esc or a click outside it closes it back to the bar; what was typed stays as the draft.
_Avoid_: drawer, popup, sidebar

**Chat page**:
The chat at its own address, opened with **Chat with Rufi** in the sidebar. A small window opens the chat as a page.

**Transcript**:
Rufi's own stored copy of the chat: your messages, the AI's replies, its notes and its reasoning, a receipt for each save, and one activity line for each thing the AI did, with everything that activity sent and got back. Each part is saved before it is shown. The notes, the reasoning's headings and the activity lines show in each reply's **Activity**; a cut step keeps what it had. The chat shows its latest page first, and older pages as the user scrolls up, with a line between days and a quiet line where the AI **started afresh**; Rufi works out both lines from the transcript when it shows it.
_Avoid_: log, history

**Started afresh**:
Where the AI began a new memory of the chat (after its own copy of the chat was lost, with the chat's last 10 messages, the AI's **notes** among them, but not its steps or thinking) or compacted its own memory of a long chat. The chat shows a quiet line there: "The AI started afresh here. It can still read earlier messages."
_Avoid_: reset, new session, new conversation

**Activity**:
What the AI did for one reply, as the AI's agent reported it, in order: its **notes**, its thinking's headings, and one step for each thing it did (read the record with one of Rufi's tools, ran a command, searched the web, changed a file, worked with a sub-agent, generated a picture, which the reply shows). Each step shows what was reported, such as the command and its exit code, or `rufi.get_records` and what the AI asked for, never Rufi's words for it; it opens to everything the agent gave about it, such as a command's output. Open and live while the AI works; folded into one line under the answer once the reply ended ("Activity · 12 steps · 1 failed · 1m 36s"), as the Activity setting says (**Show while working**, **Always show**, **Always hide**). Plain lines in the chat, not a box.
_Avoid_: trace, log, tool calls

**Note (the AI's)**:
What the AI writes while it works, before its answer, such as "I'll check your results first": a line of **Activity**, kept in full, never an answer. The AI's agent marks it as such; Rufi doesn't guess it from the words. In replies from before Rufi kept notes, they show as replies.
_Avoid_: commentary, progress message, interim reply

**Picture, page, diagram (in a reply)**:
What a reply shows besides its words. A picture is a chart from the AI's program or a picture the AI generated; a page is an HTML file the AI made, shown as a card that opens over the chat in a locked frame, self-contained (it loads nothing from the internet and can't reach Rufi); a diagram is drawn from the AI's Mermaid text. Pictures and pages are files in the AI's folder (or where it keeps the pictures it generates), shown as they are now: Rufi keeps no copy, and a file that is gone shows as such.
_Avoid_: artifact, attachment, image (say picture), HTML (say page)

**Basis**:
What an answer rests on, shown as **Based on** under the answer once the reply has ended. **How** is the AI's own words on where the answer comes from (your record, read in this reply or earlier in the chat, the web, or general knowledge) and how it got there; **Used** is the reads of the health record that Rufi handled in that reply and got an answer for (failed and capped ones too), built by Rufi from its own record of them. Commands and web searches are in **Activity**, not in Used. Small talk has none.
_Avoid_: reason, rationale, citation; "reasoning" is the AI's thinking, and a **source** is what a record rests on

**Steer**:
A message sent while the AI is replying, passed into that reply. The AI takes it at its next step, after what it is writing now, so it can change course. On screen, its button is **Add to reply**, and the transcript keeps it as your message, marked "Added to the reply".
_Avoid_: nudge, interrupt

**Queue**:
What waits to go to the AI, kept by Rufi with the chat: your messages and Rufi's notes about **Rufi events**. Rufi gives the AI one turn's worth at a time, and never the same message twice. It survives a restart and a model change. Shown above the box as the **waiting messages**.
_Avoid_: inbox, outbox

**Waiting messages**:
What the queue holds, shown above the box. Your messages sent while the AI replies wait, then go in order after the reply; you can edit, reorder or remove them. A held one says why (you're signed out, it came from a backup, the AI couldn't take it, or Rufi isn't sure it reached the AI) and goes only when you send it. After a Stop, or when Rufi starts again with messages waiting, they wait until you send a message or click **Send now**.
_Avoid_: backlog, pending messages

**Rufi event**:
Rufi's own note that something happened outside your chat, such as a reading that finished: a line in the chat, and sometimes a note for the AI. It is never your words, a request or your yes: a reply it starts can only read, never save. After a Stop, its note goes with your next message.
_Avoid_: notification, system message

**Stop**:
Ends the AI's reply now, with anything it started. What it wrote so far is kept; nothing more goes to the AI until you send a message.
_Avoid_: cancel, abort

**Interrupted**:
A reply that didn't finish because you stopped it or Rufi closed. What it wrote so far is kept, and it never runs again.
_Avoid_: cancelled, aborted

**Chip**:
Something from the record added to a message in the chat: a record (such as a result, with **Ask Rufi** on its row), a report's results (with **Ask Rufi** in its heading), a document or a draft item, shown by its name. **Ask Rufi** adds it and the page stays. In the box, a document's chip also says what Rufi is doing with it (Reading…, Waiting to read, Read, Read · some pages unclear, Couldn't read); this is worked out each time, never stored. It points at exactly that one, for this person; the AI gets its id and its version when the message is sent. Taking a chip out of the box changes nothing in the record.
_Avoid_: attachment, tag, mention

**Draft**:
The message you started in the chat and haven't sent, with its chips, saved quietly while you type; only a save that failed shows under the box ("Not saved"). The last save wins: two tabs typing at once replace each other's text. A send moves it into the queue and empties the box, in one step. Rufi never sends a draft by itself.
_Avoid_: note, unsent

**Model**:
The version of the AI that answers, such as GPT-6-Astra, chosen for the chat from the allowlist, with its **effort**, in the box. A new model answers from the next reply and has the whole chat; the AI doesn't start afresh.
_Avoid_: engine, brain

**Effort**:
How hard the AI thinks before it answers: Low, Medium or High, chosen for the chat with the model. Medium until the user chooses another. A new effort applies from the next reply; the AI doesn't start afresh.
_Avoid_: reasoning level, thinking mode

**Allowlist**:
The models Rufi may use: `models.json` in the data folder. The chat uses the first one until the user chooses another. It starts with the strongest models, GPT-6-Astra first, and you can edit it.
_Avoid_: whitelist

## Coming back to things

**Follow-up**:
Something to come back to: what, for whom, when (a date, a rough date, "at the next visit" or none) and where it came from. It is open, done (with its outcome) or dropped. An open one with a date is coming up, due during its day, month or year, and overdue after it.
_Avoid_: reminder, task, to-do

**Notice**:
The Mac notification the Rufi app shows when a person's follow-ups become due or overdue: Rufi and a count only, never a name or what the follow-up is. One per state; its click opens Follow-ups.
_Avoid_: alert, reminder, push

**Visit brief**:
A dated summary the AI writes for a doctor's visit from the saved record only, with the records it rests on as its sources. It never changes; when a later save changes the record, its page says so.
_Avoid_: handoff, summary, report

**Research entry**:
A saved write-up of something the AI looked into for a person, with its sources.
_Avoid_: note, article

**Emergency region**:
The region whose emergency number the AI gives when a message may describe an emergency. You choose it in Settings. With none chosen, the AI says to call your local emergency number and that your region isn't set; if it also gives a number, it says where the number comes from.
_Avoid_: country, locale

**Emergency sheet**:
A person's essentials (medicines, allergies, conditions, blood group, contacts) on one page to hand to someone, also without the AI.
_Avoid_: medical ID card

## Rufi and the AI

**The AI**:
The AI agent that answers in the chat and works with the record through Rufi's tools. It works in the AI's folder, where it can write and run programs and use the internet. Screens and help say "the AI"; "Codex" appears only where its folder is named.
_Avoid_: assistant, bot; "model" only for a version of the AI (see Model)

**The AI's folder**:
The folder where the AI works: `ai/` in the data folder. It keeps its programs, notes and research files there between messages, with their caches in `ai/.cache`, and it is the only place where the AI's programs can write. Nothing in it is part of the record. It isn't in backups, the export or a move yet.
_Avoid_: workspace, sandbox, scratch folder

**Tool**:
Something Rufi offers the AI, such as reading a person's Overview. Tools are how the AI works with the record.
_Avoid_: function, plugin

**Skill**:
Rufi's instructions to the AI for one job, such as saving a document or making a visit brief, in a file the AI reads when the job comes up. Rufi's other rules, such as safety, go with every message. On screen, a skill read shows as "Read Rufi's instructions".
_Avoid_: guide, prompt, plugin

**Overview**:
A short view of one person's health record. On screen it is the first page you see: **Needs you**, a **tile** for each page of the record, and the recent changes. The AI reads its own short view through a tool: who the person is, how much is in it, and their current results as printed.
_Avoid_: dashboard, summary

**Help**:
The pages that say what works in Rufi today and how to use it: in Rufi under Help, and in `docs/help/`.
_Avoid_: manual, documentation

**Sign in with ChatGPT**:
How you connect Rufi to your ChatGPT account, in your browser, so the AI runs on your ChatGPT plan.
_Avoid_: login, API key

**ChatGPT plan use**:
The permission you give Rufi when you sign in, so it can use your ChatGPT plan. Without it the AI can't answer.

**Data folder**:
The one folder on your Mac where Rufi keeps everything for your records: the record, the sign-in details, the log, the AI's own files and the AI's folder. Rufi makes it at its first start, `~/.rufi/data`, and remembers it in the location file; `RUFI_HOME` picks another one for one run.
_Avoid_: vault, profile, workspace, home

**Location file**:
`~/.rufi/location.json`, in Rufi's home next to the default data folder: the path of the data folder Rufi opens. Never health data or secrets. Rufi writes it only after the record exists, and stops when the folder it names is gone.
_Avoid_: pointer, config

**Move (the data folder)**:
Copying the whole data folder into a new, empty folder with `pnpm rufi move-data`, while Rufi doesn't run: checked, then the location file names the new folder. The old folder is kept, marked moved, and Rufi never opens it again. Unlike a restore, a move keeps the sign-in and every backup.
_Avoid_: relocate, sync

**Keychain**:
Your Mac's store for secrets. Rufi keeps the sign-in itself there, never in the data folder.

**Log**:
Rufi's diagnostic file, `logs/rufi.log` in the data folder: fixed events with checked details, never your words or health text.
_Avoid_: history, transcript

**First run**:
The short steps a new data folder starts with: what Rufi is and isn't, what goes to the AI, your name, sign in with ChatGPT (or skip), and your emergency region (or skip). Rufi keeps each step done. Until it is done, the first run fills the window, and nothing else in Rufi can be reached.
_Avoid_: onboarding, setup wizard

**Demo folder**:
A data folder of made-up people for trying Rufi, `~/Rufi-demo`, apart from yours. `pnpm demo` gives it the same test data each time and keeps only its sign-in.
_Avoid_: sandbox, test account

## Keeping your data safe

**Backup**:
A checked copy of the record and every document's original file that Rufi makes in `backups/` in the data folder when it starts and then each day. Never the sign-in, the AI's own files, the log or the allowlist. It counts only after its check passes.
_Avoid_: snapshot, archive

**Upgrade**:
What Rufi does at start when a new Rufi stores the record in a new way: a checked backup of the record as it was, in `backups/before-upgrade`, then the whole change in one step, or none of it. A record or backup from a newer Rufi is never opened or changed.
_Avoid_: migrate, update (for the record)

**Restore**:
Putting a backup into a new, empty folder, with `pnpm rufi restore`. It never changes the current data folder or overwrites anything; the copy starts signed out.
_Avoid_: recover, roll back

**Export**:
One zip with everything in the record, the chat and Rufi's settings, as JSON and CSV with a README, and every document's original file, so your data is never locked in Rufi. Not a backup: Rufi can't restore from it.
_Avoid_: download, dump

## Relationships

- **You** keep the **records** of one or more **people**.
- A **document** can hold **reports**; a **report** has **results**. A **result** can also be typed in without a report.
- A **reading** of a **document** makes **draft items**; they become **results** only when you save them. Its end is a **Rufi event** in the person's **chat**.
- A **save** changes one **person**'s **records**, rests on their messages or **documents**' pages as its **sources**, and gives one **receipt**; an **undo** is a new save.
- A message's **chips** point at the person's **results**, **documents** or **draft items**; "save it" with a document's chip saves its **draft items** as **results**.
- A **person** has one **chat**, made with them; it can produce **saves**, **follow-ups** and **research entries**.
- A **chat** has one **queue**: your messages and the notes of **Rufi events** wait there for the AI.
- The **chat** has one **transcript**, one **draft** and a **model**; a **steer** and each **activity** belong to one reply.
- An answer's **basis** belongs to its reply: How from the AI's words, Used from that reply's own **activity**.
