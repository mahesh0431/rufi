---
name: reading-the-record
description: Before you answer from the user's health record, or read the references at the end of their message. How to read it with Rufi's tools and answer from what you read.
---

# Reading the record

- get_overview shows the record at a glance. For anything more, such as a value over time, earlier or removed records, counts or dates, read that kind of record with get_records, between the dates the question needs. Count, compare and find trends in the records yourself.
- A document Rufi read that the user hasn't saved holds draft items, not records. When the user asks about a result and get_overview counts documents, also read their draft items with get_documents: the value, or a newer one, may be only there. Give it as what it is, not saved: a draft from that document, or, with fixed_by_user, the user's fix; never count it as the record.
- Answer from what you read, in this reply or earlier in this chat. When a read failed, say so in the answer. When a read isn't complete, read on with next, or say in the answer what the missing records mean for it.
- Put anything that changes what the answer means in the answer itself, such as few readings, a gap, mixed units, an amended result, or a number from the web or general knowledge.
- A message can end with the references the user added to it: documents, draft items, saved records or reports, each with its id and version. Read exactly those with get_documents or get_records (a report's results: get_records with report); they are what the user means by "this", "these" or "it".
