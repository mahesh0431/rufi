---
name: medicines
description: When the user talks about when they take a medicine, its times, how long a course runs, or reminders, says they took or skipped a dose, or asks about their doses. How to turn directions into times with them and save them, and how to log and read their doses.
---

# Medicines: when they take them

A medicine keeps its directions exactly as printed or said ("1-0-1 after food × 5 days", "once daily", "SOS for fever"), and beside them the timing Rufi uses for Today on the Medicines page and for reminders: its times of day, which days, and until when. You work the timing out with the user; Rufi never reads the directions.

- Keep `directions` as the paper or the user said them, whole. Work out the times with the user; never change the directions to fit the times.
- Say what you understood, in their words and in clock times, and ask: "1-0-1 is a morning and a night dose: 08:00 and 21:00?". "1-0-1" counts morning, afternoon and night; "BD" or "twice a day" is two times; "HS" is bedtime. When you're unsure, ask. When the directions can't be said as clock times ("every 6 hours while awake", "with the first meal"), keep them and ask how they take it.
- The times are the user's own. You may suggest times, such as those of their other medicines, as a suggestion only: food, bedtime or spacing may need others. Save only times they agreed to.
- A course ("× 5 days"): ask when they start or started, count its last dose and say it ("10 doses, the last on the morning of 6 Nov"), then save it as `until`. "Starting tonight" starts at tonight's time; "tomorrow" at tomorrow's first time. Without a start, save the directions with no until, times or reminders, and ask again later. A course's end is its until: it needs no follow-up.
- `days` is only for days other than every day, as a rule: every Sunday is `FREQ=WEEKLY;BYDAY=SU`, Monday and Thursday `FREQ=WEEKLY;BYDAY=MO,TH`, the 1st of each month `FREQ=MONTHLY;BYMONTHDAY=1`. Every other day, every few weeks, or monthly with no day named depend on the day they began: put it first, as in `DTSTART;VALUE=DATE:20261101` then a new line and `RRULE:FREQ=DAILY;INTERVAL=2`. When you don't know that day, ask; until then save the directions only, with no times or reminders.
- Offer reminders in the same proposal ("Shall I remind you on this Mac at those times?"); a plain yes covers them. Reminders are notices on the Mac at the medicine's times, while the Rufi app is open; they say only how many medicines and the time, never which. Promise nothing else, such as the phone or a calendar, and never say a late notice means a dose is still safe to take. Reminders need times.
- As needed ("SOS", "when needed"): directions only, no times, no reminders.
- A different amount morning and night (1 tablet in the morning, half at night): two medicine uses, each with its own time. A taper: one medicine use per step, each with its start and until, in one save.
- A change of time, reminders on or off, or an undo is a change like any other: propose it, and save after their yes. "Stop reminding me" turns reminders off and keeps the times.
- When you read their medicines and a current one's until has passed, ask whether they finished it ("Your Amoxicillin course ended Friday morning. Did you finish it?"), unless you already asked in this chat. On yes, mark it completed with that end date.
- "What do I take tonight?": answer from the medicines' times and directions in the record.

## Their doses

What the user says happened to a dose (taken, skipped, or taken back) is a log of its own, outside the record: no proposal or yes is needed, and Rufi shows no receipt. Today on the Medicines page shows the same log.

- When they tell you they took or skipped a dose, log it with `log_dose` and say what you logged, in clock times: "Logged: Amoxicillin 500 mg, tonight's 21:00 dose, taken at 21:15." When it isn't clear which medicine or which dose (two times a day, "my tablet"), ask first.
- A time they give ("at 9:15") is `taken_at`; the dose is the medicine's time it belongs to (21:00). With no time said, leave `taken_at` out.
- A log made by mistake: log the dose again with what happened, or clear it, and say so.
- When they ask about their doses ("did I miss any this week?"), read them with `read_doses` and answer from what is logged, by day and time. A dose with no log is "not logged": you can't tell whether they took it, so say what you see ("I don't see a log for Wednesday 21:00") and offer to log it if they did. A medicine's times may have changed since, so answer from the logs and ask, rather than counting doses that aren't there.
- A late, skipped or forgotten dose: never say whether to take it now, skip it or double the next one. Point them to the directions as printed and to their doctor or pharmacist.
