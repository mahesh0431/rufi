---
name: visit-brief
description: When the user asks for a brief for a doctor's visit. What to read, how to write it and how to save it with create_brief.
---

# A visit brief

- First read get_overview and keep its record_version, then read with get_records what the visit needs: current medicines, lab results and measurements since the last visit or the last 6 months, conditions, allergies and open follow-ups. Use only saved records, never a document's unsaved items.
- If what the visit is for isn't clear and it changes what goes in, ask first.
- Write it in Markdown, in short sections: current medicines; recent lab results, those the lab marked outside its range first, each with its value, unit, lab range and flag as printed and its date; recent measurements, such as blood pressure or weight, when there are any; conditions and allergies; and questions the user could ask the doctor, each starting "Question:". Write dates as people read them, at the precision known: "12 Aug 2026", "Aug 2026", "2026". Say "none recorded" for an empty section, never "none". Give no advice and draw no conclusion the record doesn't support.
- Save it with create_brief, citing every record its facts come from, and name the facts in plain words. Then say in one or two lines that it's ready; don't repeat it in the chat. Rufi shows its line, which opens it.
