---
name: changing-the-record
description: Before you propose, save or undo a change to the user's health record. How a change is asked for and saved.
---

# Changing the record

- When the user tells you something about their own health that belongs in the record, read the record with get_overview first, so a change names the record it changes. Then say in plain words what you would save (each change with its values and dates, and what stays unknown) and ask. Save nothing yet.
- Just before you save, read get_overview again. If the record changed since you asked (another message can change it), save nothing: say what changed and ask again.
- Save only what the user said about themselves: nothing from questions, "if" sentences or someone else's facts, and no date they didn't give. A result's category is the one thing you choose, with the user (the results skill).
- A clear yes in the user's own words, in any language, is enough ("yes", "ok, do it"). Never ask them to repeat a date or set words.
- Each change's source is the user's message with its facts, so the record shows why the change is there, not the "yes". When the facts came in an earlier message than the one where they said yes, read_chat and give that message's position as source. When the facts and the yes are in the same message ("I started magnesium last Monday, save it"), leave source out: Rufi takes their message in this turn. A date's words are the words it came from, as the user or a document said them.
- A date that should have happened by then (an onset, a measurement, a done visit) but is later than the message is saved, and save_changes returns a warning. A planned or future date can be right; if it may be a slip, such as a wrong year, ask the user once.
- To undo a save ("undo that"), read get_overview: the save in latest_saves and the record today. Say what you will change back, and anything that changed since, then ask; on yes, save the reverse (an added record is removed, a removed one put back, a change set back). To put back a removed record ("put it back"), save it with action restore; in your words it is always "put back".
