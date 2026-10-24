---
name: visits
description: When the user sends a paper from a doctor's visit (a prescription, an e-prescription, a discharge summary, a repeat slip) or tells you about a visit. How to save a Visit and the records that come from it.
---

# Visits

A Visit is one care event that happened. It keeps the doctor's words as written. The records you save from it (a medicine the user takes, a condition, a follow-up) cite it as their source, so each shows where it came from and the Visit shows what came from it. A visit to come is a follow-up.

- Read the paper's copies with get_documents (look at the page when the copy is unclear) and get_overview, then say in a few lines what it holds and which medicines are already in the user's record. Propose the Visit and the records from it, and ask "Are you taking these?" A medicine becomes one they take only on their word. Save nothing until they answer.
- as_written holds the doctor's words as written, in Markdown with the paper's own headings (diagnosis, findings, medicines, advice, tests, when to come back), the medicines they didn't take included. For a visit told in the chat, it is the user's words. reason is a short line for lists: why they went, or the diagnosis, as written.
- setting is short free text in the user's words, shown as written. Common examples include "Clinic", "Online", "Home visit", "Hospital stay", "Emergency", "Dental" and "Lab visit"; use whatever kind fits their visit.
- On their yes, one save: the Visit first, with the page in from and a ref ("v1"); then each record from it with from: [{visit: {ref: "v1"}}]. A record already in the record whose values don't change (the same medicine, continued) gets action link with the Visit. When the user's own words give a fact of a record (when they started it), give their message as source too: with from, Rufi takes no message unless you give one. When the user said only "save it" and didn't answer about the medicines, save the Visit and ask about them again.
- Some cases, as tips:
  - The doctor changed a dose: stop the old medicine (status and end date) and add the new one, both citing the Visit, so the history keeps both periods. When the user says the record had it wrong, change it instead.
  - The doctor said to stop one: ask whether they stopped; mark it stopped, citing the Visit, only on their word.
  - An online consultation or a phone call: describe it in setting in the user's words.
  - A repeat slip with no visit: a Visit with what it has; ask what's missing (who, when) once.
  - Their own choice, such as a headache tablet they picked: a medicine with their message as source, no Visit.
  - A hospital stay: date is the admission, ended the discharge; the discharge summary as written.
  - An old paper (a 2019 prescription): ask whether it's past; a medicine they took then is saved with its dates, stopped or completed.
- Offer tests and "come back in 6 weeks" as follow-ups citing the Visit, as the follow-ups skill says.
- The same visit told in the chat and then on paper is one Visit: link the page to the Visit they have, or change it with what the paper adds.
- A paper that may be someone else's (another name, a child's): ask whose it is, and save nothing until they say.
- To undo a Visit save, read get_overview's latest save: remove what it added (the Visit, a new medicine, a follow-up), set back what it changed (an old dose back to current, its end cleared), and take the Visit off a record it linked with remove_source. A record that needs both a change back and a source taken off goes in two saves.
