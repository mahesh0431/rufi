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
Everything Rufi holds as true about one person: what the user said yes to in the chat, and what came from their documents. Each record (a medicine use, visit, symptom, condition, allergy, result, care event, "none known" statement or follow-up) keeps its source and its history; removing one takes it out of the current record and keeps its history.
_Avoid_: chart, file, history

**Health record**:
What people see for the record: the sidebar's heading, Overview and the help say "your health record". The AI says it too. Tables, tools and code keep "record".
_Avoid_: your record (on screen), health file, chart

**Document**:
What the user added for a person in one go: one PDF, or photos added together, such as a lab report photographed page by page. Its pages are the PDF's pages or the photos, in order. Rufi keeps each original file exactly as it came, and the same content only once per person, until the user deletes the document. A file the user chooses goes in the chat box as a **chip** and is stored at once, but it is not yet sent: it is not listed, read or seen by the AI until a message sends it, and taking its chip out removes it from Rufi, with its pages. A file always arrives through the chat; zip files and folders are not taken yet. Once read, **Rufi AI** sorts it: each report or paper in it becomes a document of its own, with its pages of the file ("pages 1–2 of 5"), its kind, date and, for a report, its lab and report number. Each is deleted on its own.
_Avoid_: upload, attachment

**Reading**:
A **reader** copying a document's pages, for Rufi AI to sort. When a message sends files that aren't read yet, Rufi names them, with the pages to read, in its note to **Rufi AI**, which starts a reader for each file or gives a file to a reader at work, and sets it on the document; the message itself steers or queues like any other. The document shows **Reading** while that reader is at work and hasn't saved. The reader saves its copies all at once, and its result wakes Rufi AI, which sorts the file (**sorting**). A reading that fails or stops saves nothing; Rufi AI hears it, and may start a reader again or tell the user. Pages that could not be read are read again only when the user asks: a chip marked **read again**, or in the chat. An older Rufi read files itself, in the reply before the AI; its readings keep what they saved, and one that stopped shows **Failed** with **Retry**.
_Avoid_: import, scan, parsing, extraction

**Reader**:
A **sub-agent** Rufi AI starts to read a document, with Rufi's instructions for copying pages and the Rufi tools Rufi AI gives it (look at a page, save its copies). A document keeps its reader, the one Rufi AI set on it last; one reader can read several documents. It copies what is printed, and marks what is unclear; it decides nothing (not the kind, date or results), never judges your results and never saves to the record. Its saved copies get no **receipt**: they aren't the record.
_Avoid_: parser, OCR, extractor

**Page copy**:
The reader's copy of one page of a document, as Markdown, exactly as printed, with its marks where something was unclear (a smudged digit, handwriting, a crossed-out value). One for each page and reading, kept as the reader wrote it; it decides nothing and is not your record. It is known by the file and its page, not by the document the page is in. A page's current copy is the one from its latest finished reading.
_Avoid_: extraction, transcription, OCR text

**Sorting**:
Rufi AI's work on a file once it is read, usually when its reader's result wakes it: it splits the file into documents and drafts their results from the page copies, as much of it at once as it chooses, each call kept whole or not at all, then answers what the user wrote, or tells them what it found when they wrote nothing. It saves nothing without the user's yes. A file read and not sorted shows **Not sorted yet** (Rufi AI asked the user, or its reply failed or was stopped) with **Ask Rufi**; nothing tries again by itself. The user can ask Rufi AI to sort a file again in the chat.
_Avoid_: classification, grouping, parsing

**Draft item**:
One result or measurement Rufi AI drafted from a page copy, with its value as the copy prints it (for a digit the reader marked unclear, Rufi AI's reading) and the words it came from, marks included (**From the page**), waiting for you: not part of your record, so it counts in no Overview or trend until you save it; when the AI gives one in an answer, it says it isn't saved yet. The drafted values are kept beside any change. It points to its document and page, and may be **worth a look**, with Rufi AI's reason (on a reading from an older Rufi, why its reader wasn't sure). It names the reading of the page it was drafted from; one whose page was read again after that reading is out of date and can't be saved. It waits until it is saved (new, as another source of a saved result, or as a correction) or dismissed (set aside, as the document's page says); a dismissed item is never saved.
_Avoid_: pending result, unconfirmed record, extracted row

**Report**:
A lab or clinic report: one document as Rufi AI sorted it, with who issued it, its printed report number and when the sample was collected. The results saved from it belong to it.
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

**Medicine use**:
One medicine or supplement the person takes or took, in one way (a morning and a night dose are two), with its status: taking now, paused, stopped or completed. It becomes one only on the person's word; a medicine a doctor proposed is in the visit's words until then. The **Medicines** page.
_Avoid_: prescription (that is a paper), medication list, drug

**Visit**:
One care event that happened, with its kind in the person's words, such as a clinic, dental or lab visit, a phone call or a stay in hospital (admitted and discharged). It keeps the doctor's words as written, the medicines proposed included, and its paper's page as its source; the records saved from it cite it. A visit to come is a follow-up. A **prescription** is a kind of document: the paper from a visit, not a record of its own.
_Avoid_: consultation, encounter, appointment

**Care event**:
A procedure or an immunisation, planned or done. A visit to a doctor is a **visit**.
_Avoid_: event, intervention

**Source**:
Where a saved record came from: the user's own message in the chat, a document and its page, or a visit (a record saved from a visit cites the visit; the visit cites its paper's page). A message source is the user's message with the facts the record came from, never their "yes" alone and never words the AI quotes: the AI names an earlier message by its place in the chat, and with none named it is the user's message in that turn. A record can have several, such as a result the user told the AI and then added in a lab report; the same result from another copy is another source, not another result. Undo of another source takes only that source off. A date keeps the words it came from ("last Monday"), which count from when the source message was sent.
_Avoid_: origin, provenance, attachment

## Changes

**Save**:
One change to the record that the user agreed to in the chat: the AI's call to save it, then every record it changed, each with its before and after, and its receipt, all together or none. The same call again saves nothing new.
_Avoid_: change set, batch, transaction, commit

**Receipt**:
What Rufi adds to the chat for each save: "Saved", then one line for each change, written from what was saved, never from the AI's words. A save of a document's draft items starts with a summary (how many new, more sources and corrections), and its lines say each one's page. A **sub-agent**'s names it by its title after "Saved".
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
The box at the bottom right of the pages where you read your health (Overview, the record's pages, Follow-ups, Documents, a document's page, a visit brief), a pill with the model and effort and Send: the person's chat, the same in every browser tab. The pages leave room for it, so it covers nothing. It is one line, always the same size: what **Ask Rufi** added (the first chip's name and how many more), then the start of the draft, or a reason for the moment; a click opens the chat panel. While a reply runs, it shows a turning circle, with Stop. Help and Settings reach the chat with **Chat with Rufi** in the sidebar.
_Avoid_: composer, input

**Chat panel**:
The chat opened over the page from the chat bar (or with ⌘J), always the same size, with a thin top bar: – back to the bar, and the arrows to the chat page. –, Esc or a click outside it closes it back to the bar; what was typed stays as the draft.
_Avoid_: drawer, popup, sidebar

**Chat page**:
The chat at its own address, opened with **Chat with Rufi** in the sidebar. A small window opens the chat as a page.

**Transcript**:
Rufi's own stored copy of the chat: your messages, the AI's replies with the questions it asks, and a receipt for each save, each saved before it is shown. What the AI did for each reply (one activity line for each thing it did, with everything it sent and got back, its notes and its reasoning) is kept in the AI's working state, `agents.sqlite`, and shown with the reply; a note's or a summary's text shows as it comes and is kept once whole, or as far as it came when the reply ends. Replies from before this version keep theirs in the transcript. The notes, the reasoning's headings and the activity lines show in each reply's **Activity**; a cut step keeps what it had. The chat shows its latest page first, and older pages as the user scrolls up, with a line between days and quiet lines where a **new thread** started and where the chat history was **compacted**; Rufi works out these lines from the transcript when it shows it.
_Avoid_: log, history

**New thread**:
A new working memory of the chat for the AI. It starts only when the AI's own copy of the chat is gone (a restore, a move of Rufi's data, its files deleted), or when the user clicks **New thread** on a message that waits because the AI's thread didn't open. The chat and the health record stay as they are; the AI gets the chat's last 10 messages and replies, without its notes, steps or thinking, and reads further back when it needs to. The chat shows a quiet line there: "New thread started". Another model or effort, or a change of Rufi's rules, keeps the same thread; a model of another provider starts a new thread there, with the chat's last messages.
_Avoid_: started afresh, reset, new session, new conversation

**Chat history compacted**:
The AI's memory of a long chat got near full, and Codex replaced its older part with a summary, in the same thread. The chat shows "Compacting chat history…" while it runs and "Chat history compacted" once it is done; nothing when it was cut off (a Stop, Rufi closed). The chat itself stays whole.
_Avoid_: started afresh, reset, summarised

**Context used**:
How much of the AI's memory of the chat its thread uses, as Codex last reported it: the last request's tokens over the model's context window, as a percentage, shown as a small grey ring beside the model and effort. It shows after the AI's first report in the thread, keeps its value after a reload, and shows nothing when Codex doesn't say the window.
_Avoid_: tokens left, memory full

**Activity**:
What the AI did for one reply, as the AI's agent reported it, in order: its **notes**, its thinking's headings, and one step for each thing it did (read the record with one of Rufi's tools, ran a command, searched the web, changed a file, worked with a sub-agent, generated a picture, which the reply shows). A **sub-agent** it started is one line, its title, status and the start of its result, which opens that agent's own Activity; its own sub-agents open there the same way. Each step shows what was reported, such as the command and its exit code, or `rufi.get_records` and what the AI asked for, never Rufi's words for it; it opens to everything the agent gave about it, such as a command's output. Open and live while the AI works; folded into one line under the answer once the reply ended ("Activity · 12 steps · 1 failed · 1m 36s"), as the Activity setting says (**Show while working**, **Always show**, **Always hide**). Plain lines in the chat, not a box.
_Avoid_: trace, log, tool calls

**Note (the AI's)**:
What the AI writes while it works, before its answer, such as "I'll check your results first": a line of **Activity**, kept in full, never an answer. The AI's agent marks it as such; Rufi doesn't guess it from the words. In replies from before Rufi kept notes, they show as replies.
_Avoid_: commentary, progress message, interim reply

**Picture, page, diagram (in a reply)**:
What a reply shows besides its words. A picture is a chart from the AI's program or a picture the AI generated; a page is an HTML file the AI made, drawn in the reply in a locked frame and opened large over the chat, self-contained (it loads nothing from the internet and can't reach Rufi); a diagram is drawn from the AI's Mermaid text. Pictures and pages are files in the AI's folder (or where it keeps the pictures it generates), shown as they are now: Rufi keeps no copy, and a file that is gone shows as such.
_Avoid_: artifact, attachment, image (say picture), HTML (say page)

**Basis**:
What an answer rests on: **How**, the AI's own words on where the answer comes from (your record, read in this reply or earlier in the chat, the web, or general knowledge) and how it got there. It shows as **Based on** beside the answer's **Activity** once the reply has completed, and opens as plain text. What the AI read is in Activity, each read a step. Small talk has none.
_Avoid_: reason, rationale, citation; "reasoning" is the AI's thinking, and a **source** is what a record rests on

**Steer**:
A message sent while the AI is replying, passed into that reply; the AI carries on with it in mind, told in one line that it is being steered. It waits in the **queue** like any other until the AI takes it. While a reply runs, Enter steers unless Settings says queue; **Steer** beside the box, or on a waiting message, does it too.
_Avoid_: nudge, interrupt

**Queue**:
What waits to go to the AI, kept by Rufi with the chat: your messages and Rufi's notes about **Rufi events**. Rufi gives the AI one at a time, and never the same message twice: a message counts as sent once Rufi hands it to the AI. Each starts a turn of its own, except a message you **steer** into the running reply; one you queue while the AI replies waits for a reply of its own. A message with files goes the same way. It survives a restart and a model change. Shown in the chat as the **waiting messages**.
_Avoid_: inbox, outbox

**Waiting messages**:
What the queue holds, shown in the chat after its last message as soon as you send; you can steer, edit, reorder or remove your messages there. A held one says **Failed** with the error as it came, or **Not sent** with why (Stop cut its start off, or it came from a backup), and goes only when you send it. Signed out, a send takes nothing: the text and chips stay in the box. After a Stop, what waits goes on, in order; a message whose start a Stop cut off is held, **Not sent · Stopped.** After a **restart**, a reply that ran carries on first, then what waits goes on; when the AI stopped carrying on, what waits is held, **Not sent · Stopped after 5 restarts in a row.**, until you send it or a new message. The AI can do the same when you ask, and with what waits for its sub-agents (`waiting_messages`); steering a held one sends it.
_Avoid_: backlog, pending messages

**Rufi event**:
Rufi's own note that something happened outside your chat, such as a deleted document: a line in the chat, and sometimes a note for the AI. It is never your words, a request or your yes: in a reply it starts, the AI carries on work you already asked for and asks you before a new change. Its note goes in a reply of its own, also after a Stop.
_Avoid_: notification, system message

**Stop**:
Ends the AI's reply now. What it wrote so far is kept; what waits goes on, in order, and its **sub-agents** keep working. The AI can stop a sub-agent, or itself, with everything under it: then all of them stop, what waits for any of them doesn't go (your messages show **Not sent · Stopped.**), and none of their results wakes another.
_Avoid_: cancel, abort

**Interrupted**:
A reply that didn't finish because you stopped it or Rufi closed. What it wrote so far is kept, and it never runs again. When Rufi closed, the AI carries on in a new reply after the **restart**.
_Avoid_: cancelled, aborted

**Restart**:
Rufi starting again after it quit or stopped suddenly during the AI's work. The AI and its **sub-agents** that were working carry on by themselves, each in a new turn, before what waits. After too many restarts in a row (**Settings** › **After a restart**, 5 at the start) they stay stopped instead. A restore, or a missing `agents.sqlite`, is not one: agent work is gone, and nothing carries on.
_Avoid_: resume, recovery

**Chip**:
Something from the record added to a message in the chat: a record (such as a result, with **Ask Rufi** on its row), a report's results (with **Ask Rufi** in its heading), a document or a draft item, shown by its name. **Ask Rufi** adds it and the page stays. A document's chip may be marked **read again** (from **Retry**), so that sending it reads its unreadable pages again; it shows no reading state. It points at exactly that one, for this person; the AI gets its id and its version when the message is sent. Taking a chip out of the box changes nothing in the record, except a file that was not yet sent, which leaves Rufi.
_Avoid_: attachment, tag, mention

**Draft**:
The message you started in the chat and haven't sent, with its chips, saved quietly while you type; only a save that failed shows under the box ("Not saved"). The last save wins: two tabs typing at once replace each other's text. A send moves it into the queue and empties the box, in one step. Rufi never sends a draft by itself.
_Avoid_: note, unsent

**Model**:
The version of the AI that answers, such as GPT-6-Astra, chosen for the chat from the **shortlist**, with its **effort**, in the box. A new model answers from the next reply, in the same thread, with the whole chat; one of another provider starts a new thread there, with the chat's last messages.
_Avoid_: engine, brain

**Effort**:
How hard the AI thinks before it answers: Low, Medium or High, chosen for the chat with the model. Medium until the user chooses another. A new effort applies from the next reply, in the same thread.
_Avoid_: reasoning level, thinking mode

**Shortlist**:
The models the AI and its agents may run on, ticked in **Settings** › **Models**: GPT-6-Astra and GPT-6.1-Sol until the user chooses. The ticked ones come first there, in the order they were ticked. The chat's menu offers those the plan offers now, and a new chat uses the first. An agent starts on one of them or is moved to one; any other is refused. An old `models.json` in the data folder is left as it is and not used.
_Avoid_: allowlist, whitelist

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
The AI agent that answers in the chat and works with the record through Rufi's tools; also called **Rufi AI**, beside the **reader**, where both are named. It works in the AI's folder, where it can write and run programs and use the internet. Screens and help say "the AI", or "Rufi AI" next to the reader; "Codex" appears only where its folder is named.
_Avoid_: assistant, bot; "model" only for a version of the AI (see Model)

**Agent**:
An AI working in a conversation of its own, on a model and effort, with the tools Rufi gives it. Rufi AI is the chat's own agent; the agents it starts, and theirs, are its **sub-agents**. Every agent is one chat's, and works for that person only.
_Avoid_: worker, thread (a conversation is the agent's, not the agent)

**Sub-agent**:
An agent another agent started for one task, with a title, such as checking a set of results. It sees its task and nothing of the chat, runs on the model and effort of the agent that started it, or others of the **shortlist** it was given, with the same tools or fewer, and goes on after the reply ends. What it saves to the record shows in the chat with Rufi's **receipt**, which names it by its title. When its turn ends, the agent that started it hears how it went (its **done message**), and Rufi AI says what it found. In the **Activity** of the reply that started it, it is one line that opens what it did.
_Avoid_: helper, child (in screens and help), delegate

**Done message**:
What an agent is told when one it started ends a turn: its title, and its whole answer with any questions and their options, or that it stopped or failed and why. It goes into the agent's turn, or starts one; for Rufi AI, that reply shows a small line naming the sub-agent ("Reading report.pdf: done"). It is never the user's words.
_Avoid_: callback, notification

**The AI's folder**:
The folder where the AI works: `ai/` in the data folder. It keeps its programs, notes and research files there between messages, with their caches in `ai/.cache`, and it is the only place where the AI's programs can write. Its working notes go in `ai/work/`, a folder for each day; at each start and once a day Rufi removes the days older than 3, and a deleted document's notes go with it. Nothing in it is part of the record. It isn't in backups, the export or a move yet.
_Avoid_: workspace, sandbox, scratch folder

**Tool**:
Something Rufi offers the AI, such as reading a person's Overview. Tools are how the AI works with the record; a few are about the conversation only, such as showing a face on Rufi.
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

## Device data

**Device data**:
What a person's devices measure, such as their resting heart rate each day from Apple Health. Kept apart from the record: nobody confirms it in the chat, it has no receipts, and only **Keep values** deletes it. Nothing shows it yet but Settings.
_Avoid_: health data (for this alone), wearable data, record (for it)

**Device source**:
One device or app connected for one person, for good, such as their iPhone sending Apple Health. Its data goes only to that person.
_Avoid_: device (for the connection), integration, account

**Batch**:
What a device source sends in one go: values and the IDs of values it takes back. Rufi stores it first, exactly as it came, then converts it in the background, in the order batches came.
_Avoid_: page, upload, sync

**Device value**:
One thing a device measured, in Rufi's terms: its type, number and unit, when, and the device; where it was measured only when the device says. Known by the source's own ID.
_Avoid_: reading (that is a document's), sample, data point, measurement (that is a result)

**Device type**:
What a device value measures, from Rufi's own list, such as resting heart rate, with its unit and LOINC code. Its key never changes.
_Avoid_: metric, kind (that is a record's)

**Keep values**:
How long Rufi keeps device values, for everyone in the data folder: 30 days, 12 months or forever. A shorter time asks before it deletes.
_Avoid_: retention (on screen)

## Keeping your data safe

**Backup**:
A checked copy of the record and every document's original file that Rufi makes in `backups/` in the data folder when it starts and then each day. Never the sign-in, the AI's own files or the log. It counts only after its check passes.
_Avoid_: snapshot, archive

**Upgrade**:
What Rufi does at start when a new Rufi stores the record in a new way: a checked backup of the record as it was, in `backups/before-upgrade`, then the whole change in one step, or none of it. A record or backup from a newer Rufi is never opened or changed.
_Avoid_: migrate, update (for the record)

**Restore**:
Putting a backup into a new, empty folder, with `pnpm rufi restore`. It never changes the current data folder or overwrites anything; the copy starts signed out.
_Avoid_: recover, roll back

**Export**:
One zip with everything in the record, the chat, device data and Rufi's settings, as JSON and CSV with a README, and every document's original file, so your data is never locked in Rufi. Not a backup: Rufi can't restore from it.
_Avoid_: download, dump

## Relationships

- **You** keep the **records** of one or more **people**.
- A **document** can hold **reports**; a **report** has **results**. A **result** can also be typed in without a report.
- A **reader** Rufi AI starts makes a **reading** of a **document**: its **page copies**. The reader's result wakes Rufi AI, whose **sorting** makes **documents** and their **draft items**; they become **results** only when you save them.
- A **save** changes one **person**'s **records**, rests on their messages, **documents**' pages or **visits** as its **sources**, and gives one **receipt**; an **undo** is a new save.
- A **visit** rests on its paper's page; the **records** saved from it (a **medicine use**, a condition, a **follow-up**) cite it, and one record can cite several visits.
- A message's **chips** point at the person's **results**, **documents** or **draft items**; "save it" with a document's chip saves its **draft items** as **results**.
- A **person** has one **chat**, made with them; it can produce **saves**, **follow-ups** and **research entries**.
- A **chat** has one **queue**: your messages and the notes of **Rufi events** wait there for the AI.
- The **chat** has one **transcript**, one **draft** and a **model**; a **steer** and each **activity** belong to one reply.
- A **device source** belongs to one **person** for good; a **batch** comes from one source; a **device value** comes from batches of one person's sources, and has one **device type**.
- An answer's **basis** belongs to its reply: How, from the AI's words at the end of that reply.
