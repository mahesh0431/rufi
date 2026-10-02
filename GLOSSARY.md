# Rufi

A family health record on your Mac: you keep the records of a few people, and an AI helps by reading the record and proposing changes you approve. The same words are used on screen, in the docs, in the AI's instructions and in the code.

## People

**You (the user)**:
The one person using Rufi on this Mac, keeping records for themselves and others. Screens and help say "you" or use your name; the AI's instructions and code say "the user".
_Avoid_: keeper, owner, admin, caregiver

**Person**:
Someone whose health record Rufi keeps; you are often one of them.
_Avoid_: patient, profile, member

## The record

**Record**:
Everything Rufi holds as true about one person: what the user entered or accepted.
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
Where something came from, such as a document, a message in a conversation, the user typing it in, a record item or a research entry.
_Avoid_: origin, provenance

## Changes

**Proposal**:
A change to a person's record that the AI, or another app, wants to make. Nothing in the record changes until the user accepts it.
_Avoid_: suggestion, pending change, draft

**Card**:
How a proposal is shown: person, action, old and new values, the date it takes effect, and its source, with Accept, Edit and Dismiss.
_Avoid_: proposal card, confirmation

**Stale proposal**:
A proposal whose part of the record changed after it was made; it can't be accepted until it is reviewed again.

**Change set**:
Everything one acceptance changed in the record. Undo reverts a change set as a whole.
_Avoid_: batch, transaction

**Receipt**:
The confirmation that a change set was saved, shown only after it was.
_Avoid_: toast, success message

**Needs you**:
The list of what is waiting for the user for one person: proposals and documents to review.
_Avoid_: inbox, notifications, tasks

## Conversations

**Conversation**:
An exchange between the user and Rufi's AI about one person, kept by Rufi.
_Avoid_: thread, session

**Chat**:
The panel and box where the user talks with Rufi's AI; what is said there is a conversation.

**Transcript**:
Rufi's own stored copy of a conversation: messages, what the AI read and did, cards and receipts.
_Avoid_: log, history

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

**Emergency button**:
Always on screen; shows the local emergency number and what to do now, and works without the AI.
_Avoid_: SOS, panic button, alert

**Emergency sheet**:
A person's essentials (medicines, allergies, conditions, blood group, contacts) on one page to hand to someone, also without the AI.
_Avoid_: medical ID card

## Relationships

- **You** keep the **records** of one or more **people**.
- A **document** can hold **reports**; a **report** has **results**. A **result** can also be typed in without a report.
- A **proposal** belongs to one **person**; accepting it saves one **change set** and gives one **receipt**.
- A **conversation** is about one **person** and can produce **proposals**, **follow-ups** and **research entries**.
