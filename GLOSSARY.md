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

**Document**:
An original file the user added for a person, such as a lab report PDF or a photo of a prescription, kept exactly as it came.
_Avoid_: upload, attachment

**Report**:
A lab or clinic report read from a document: who issued it and when the sample was collected.
_Avoid_: lab sheet, test report

**Result**:
One lab test or measurement, kept exactly as reported or entered: name, value, unit, reference range, the lab's own flag, method or context, and when it was measured at the precision known. A measurement such as weight is a result typed in without a report.
_Avoid_: reading, lab value

**As printed**:
Exactly what the source shows, kept unchanged. A printed "High" is the lab's word, never Rufi's judgement.
_Avoid_: normalised, cleaned

**Amended result**:
A result the lab issued again, replacing an earlier version; its value or any other reported detail may differ, and the earlier version is kept.
_Avoid_: corrected, updated, overwritten

**Source**:
Where something came from, such as a document, a message in a conversation, a record item or a research entry. A change saved from the chat rests on the user's own message in that conversation, and a date said in words ("last Monday") counts from when that message was sent.
_Avoid_: origin, provenance

## Changes

**Save**:
One change to the record that the user agreed to in the chat: the AI's call to save it, then every record it changed, each with its before and after, and its receipt, all together or none. The same call again saves nothing new.
_Avoid_: change set, batch, transaction, commit

**Receipt**:
What Rufi adds to the conversation for each save: "Saved", then one line for each change, written from what was saved, never from the AI's words.
_Avoid_: toast, success message, confirmation

**Undo**:
Saving the reverse of an earlier save, by chat: the user says "undo that", the AI says what will change back and anything that changed since, and saves it after the user says yes. The earlier save stays in the history.
_Avoid_: revert, rollback

**Needs you**:
The list of what is waiting for the user for one person, such as documents to review.
_Avoid_: inbox, notifications, tasks

## Conversations

**Conversation**:
An exchange between the user and Rufi's AI about one person, kept by Rufi. **New conversation** creates it at once; its name is the first words of its first message the AI took, "New conversation" until then.
_Avoid_: thread, session

**Chat**:
Where the user talks with Rufi's AI: one conversation, shown in three sizes (the chat bar, the chat panel and the chat page) with the same box.

**Chat bar**:
The box at the bottom right of every page. It shows the conversation the user chose last for the person in this tab; with none yet, using it starts one.
_Avoid_: composer, input

**Chat panel**:
The chat opened over the page from the chat bar (or with ⌘J), always the same size. Esc closes it.
_Avoid_: drawer, popup, sidebar

**Chat page**:
A conversation at its own address, listed under Conversations in the sidebar. A small window opens the chat as a page.

**Transcript**:
Rufi's own stored copy of a conversation: your messages, the AI's replies and its reasoning, a receipt for each save, and one activity line for each thing the AI did, with everything that activity sent and got back. Each part is saved before it is shown; the reasoning and what each activity sent and got back aren't shown yet.
_Avoid_: log, history

**Activity**:
One line in a transcript for something the AI did: read the record with a tool, ran a command, searched the web, changed a file, worked with a sub-agent, or did something Rufi can't display yet. The line shows a short title and one short detail (the search words, the command); Rufi also keeps everything the activity sent and got back, such as the records a read got back or a command's output.
_Avoid_: trace, steps, log

**Basis**:
What an answer rests on, shown as **Based on** under the answer once the reply has ended. **How** is the AI's own words on where the answer comes from (your record, read in this reply or earlier in the conversation, the web, or general knowledge) and how it got there; **Used** is what Rufi saw the AI read in that reply, built by Rufi. Small talk has none.
_Avoid_: reason, rationale, citation; "reasoning" is the AI's thinking, and a **source** is what a record rests on

**Steer**:
A message sent while the AI is replying, passed into that reply. The AI takes it at its next step, after what it is writing now, so it can change course. The transcript keeps it as your message, marked as a steer.
_Avoid_: nudge, interrupt

**Waiting messages**:
Messages sent while the AI is replying. They wait, then run in order after the reply. You can edit, reorder or delete them, or run one now. After a Stop they keep waiting until you send a message or run one now. The code calls them the queue.
_Avoid_: backlog, pending messages

**Stop**:
Ends the AI's reply now, with anything it started. What it wrote so far is kept; waiting messages keep waiting.
_Avoid_: cancel, abort

**Interrupted**:
A reply that didn't finish because you stopped it or Rufi closed. What it wrote so far is kept, and it never runs again.
_Avoid_: cancelled, aborted

**Draft**:
A message you started and haven't sent, one for each conversation, saved while you type ("Saved" under the box). While a send holds it, nobody can change it. Rufi never sends a draft by itself.
_Avoid_: note, unsent

**Model**:
The version of the AI that answers, such as GPT-6-Astra, chosen for each conversation from the allowlist. A new model starts the AI afresh with the conversation's last 10 messages; it can read further back.
_Avoid_: engine, brain

**Allowlist**:
The models Rufi may use: `models.json` in the data folder. A new conversation uses the first one. It starts with the strongest models, GPT-6-Astra first, and you can edit it.
_Avoid_: whitelist

## Coming back to things

**Follow-up**:
Something to come back to: what, for whom, when (a date, a rough date, "at the next visit" or none) and where it came from.
_Avoid_: reminder, task, to-do

**Visit brief**:
A dated summary made for a doctor's visit.
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
The AI agent that answers in the chat and works with the record through Rufi's tools. Screens and help say "the AI"; "Codex" appears only where its folder is named.
_Avoid_: assistant, bot; "model" only for a version of the AI (see Model)

**Tool**:
Something Rufi offers the AI, such as reading a person's Overview. Tools are how the AI works with the record.
_Avoid_: function, plugin, skill

**Overview**:
A short view of one person's record: who they are, how much is in it, and their current results as printed. The AI reads it through a tool, and it is the first page you see.
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
The one folder on your Mac where Rufi keeps everything for your records: the record, the sign-in details, the log and the AI's own files.
_Avoid_: vault, profile, workspace

**Keychain**:
Your Mac's store for secrets. Rufi keeps the sign-in itself there, never in the data folder.

**Log**:
Rufi's diagnostic file, `logs/rufi.log` in the data folder: fixed events with checked details, never your words or health text.
_Avoid_: history, transcript

**First run**:
The short steps a new data folder starts with: what Rufi is and isn't, what goes to the AI, your name, sign in with ChatGPT (or skip), and your emergency region (or skip). Rufi keeps each step done.
_Avoid_: onboarding, setup wizard

## Keeping your data safe

**Backup**:
A checked copy of the record that Rufi makes in `backups/` in the data folder when it starts and then each day. It holds the record only: never the sign-in, the AI's own files, the log or the allowlist. It counts only after its check passes.
_Avoid_: snapshot, archive

**Restore**:
Putting a backup into a new, empty folder, with `pnpm rufi restore`. It never changes the current data folder or overwrites anything; the copy starts signed out.
_Avoid_: recover, roll back

**Export**:
One zip with everything in the record, the conversations and Rufi's settings, as JSON and CSV with a README, so your data is never locked in Rufi. Not a backup: Rufi can't restore from it.
_Avoid_: download, dump

## Relationships

- **You** keep the **records** of one or more **people**.
- A **document** can hold **reports**; a **report** has **results**. A **result** can also be typed in without a report.
- A **save** changes one **person**'s **records**, rests on their messages as its **sources**, and gives one **receipt**; an **undo** is a new save.
- A **conversation** is about one **person** and can produce **saves**, **follow-ups** and **research entries**.
- A **conversation** has one **transcript**, one **draft**, a **model** and its **waiting messages**; a **steer** and each **activity** belong to one reply.
- An answer's **basis** belongs to its reply: How from the AI's words, Used from that reply's own **activity**.
