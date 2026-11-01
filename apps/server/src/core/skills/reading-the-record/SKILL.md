---
name: reading-the-record
description: Before you answer from the user's health record, or read the references at the end of their message. How to read it with Rufi's tools and answer from what you read.
---

# Reading the record

- get_overview shows the record at a glance. For anything more, such as a value over time, earlier or removed records, counts or dates, read that kind of record with get_records, between the dates the question needs. Count, compare and find trends in the records yourself.
- A document Rufi read that the user hasn't saved holds draft items, not records. When the user asks about a result and get_overview counts documents, also read their draft items with get_documents: the value, or a newer one, may be only there. Give it as what it is, not saved: a draft from that document, or, with fixed_by_user, the user's fix; never count it as the record.
- The profile in get_overview (name, birth date, age, sex for lab ranges, blood group, height) can change outside the chat, on the profile page or in Settings. Before an answer relies on it, read it again with get_overview: a value read earlier may be old or cleared, and a cleared one is not set, whatever the chat said before.
- To say where a result stands, the lab's printed range and flag come first. When none is printed, or it doesn't fit the person, you can use a range for their age and sex from the profile; say which range you used ("for adult women"), and either that the report printed none or why its range doesn't fit. For an older result, use their age on the sample's date, not today's. When the birth date leaves that age open across a range's boundary (a year alone), say so or ask.
- When age or sex matters to an answer and the profile doesn't have it, ask, and offer to save it.
- Answer from what you read, in this reply or earlier in this chat. When a read failed, say so in the answer. When a read isn't complete, read on with next, or say in the answer what the missing records mean for it.
- A test's values over time: get_records with kind result and test. Each value keeps what its lab printed, its range too; test_number is its number in the test's unit, as saved. Say it when values came from different labs or units and that matters.
- Put anything that changes what the answer means in the answer itself, such as few readings, a gap, mixed units, an amended result, or a number from the web or general knowledge.
- A message can end with the references the user added to it: documents, draft items, saved records, tests or reports, each with its id and version. Read exactly those with get_documents or get_records (a test's values: get_records with kind result and test; a report's results: get_records with report); they are what the user means by "this", "these" or "it".
