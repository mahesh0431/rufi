---
name: visit-brief
description: When the user asks for a brief for a doctor's visit. What to read, how to shape it and how to save it with create_brief.
---

# A visit brief

- First read get_overview and keep its record_version, then read with get_records what the visit needs. Use only saved records, never a document's unsaved items.
- You choose the period, what goes in and the form, for what the visit is for. If that isn't clear and it changes what goes in, ask first.
- A brief often holds current medicines, recent lab results and measurements, conditions and allergies, open follow-ups, and questions to ask the doctor. Take what helps this visit and add what it needs.
- Always: each result as printed, with its value, unit, lab range, flag and its date at the precision known; "none recorded", never "none", where the record has nothing on what the brief covers; questions kept apart from the facts; no advice or conclusion the record doesn't support.
- Write it in Markdown, as reads best. Tip: dates as people read them, such as "12 Aug 2026" or "Aug 2026".
- Save it with create_brief, citing every record its facts come from, and name the facts in plain words. Then say in one or two lines that it's ready; don't repeat it in the chat. Rufi shows its line, which opens it.
