# Follow-ups

A follow-up is something to come back to, such as a recheck or a question for your doctor. You save one in the chat. Rufi shows it on the **Follow-ups** page and in **Needs you** on Overview. While the Rufi app is open, it also tells you on your Mac when one comes due. This page says how to save one, when it is due, and what the notices on your Mac show.

## Save a follow-up

Tell the AI in the chat, for example "Remind me to recheck my HbA1c in December". The AI says what it would save and asks; it saves only after you say yes, as for every change (see [Changing your record](chat.md#changing-your-record)).

When a document or your words suggest one, for example a report that says "Repeat HbA1c in 3 months", the AI suggests a follow-up and asks. It saves nothing until you say yes.

The date stays as you gave it:

- "December" is the month of December: due all of December. Rufi never makes it into a day.
- "In 3 months" becomes a month, counted from the day you said it or the report's date. The AI says which month when it asks.
- "On 3 December at 14:30" is that day, from that time.
- "At the next visit" has no date. Bring it up at your next visit.
- With no time at all, it has no date.

Everything else also starts in the chat:

- **Done:** say so, for example "I did the recheck, it was 6.5". The AI saves the new result, then marks the follow-up done with what came of it, linked to that result. It asks once for both.
- **Not needed:** say so. The AI marks it dropped, with the reason.
- **A new date:** say it. The follow-up is due on the new date, and Rufi tells you again then.

On the Follow-ups page, **Ask Rufi** on a row puts that follow-up in the chat's box, so you can say what to change. You stay on the page; click the chat bar to write and send.

## When a follow-up is due

| Its date               | Due                        | Overdue from      |
| ---------------------- | -------------------------- | ----------------- |
| A year: 2026           | all of 2026                | 1 January 2027    |
| A month: December 2026 | all of December            | 1 January 2027    |
| A day: 3 December 2026 | all of 3 December          | 4 December, 00:00 |
| A day and a time       | from that time to midnight | the next day      |
| At the next visit      | never                      | never             |
| No date                | never                      | never             |

Rufi uses your Mac's date and time. Before it is due, a follow-up is **coming up** when it is due in the next 30 days, and **later** after that.

## The Follow-ups page

In the sidebar, click **Follow-ups**. The number next to it is how many follow-ups are open. The page lists them in groups, in this order:

1. **Overdue**, for example "Overdue · was due Sep 2026".
2. **Due now**, for example "Due this month" or "Due today at 14:30".
3. **Coming up:** due in the next 30 days, for example "Due tomorrow" or "Due 3 Nov 2026".
4. **Later.**
5. **At the next visit.**
6. **No date.**
7. **Done** and **Dropped**, with what came of each.

A follow-up about a record shows it under its name, for example "About: HbA1c 6.8 % · 12 Aug 2026". Click it to open that record on its own page. If the lab amended that result since, the line keeps the value the follow-up was about and adds what it was amended to ("· amended to 4.6 mIU/L"), and the link opens the current result, which shows the earlier value under **Replaces**. Click a follow-up's name to see its sources and history.

The page shows the new day by itself: when it is open over midnight, it changes within a minute, and when you come back to its window, it reads again at once.

## Needs you

Overview's **Needs you** shows the follow-ups that are overdue, due now, or coming up in the next 30 days, after any documents that wait for you. **Open** opens that follow-up on the Follow-ups page. **Ask Rufi** puts it in the chat's box, the same as on the Follow-ups page. Needs you is always right, also when a notice didn't show.

## Notices on your Mac

When a follow-up becomes due, and again when it becomes overdue, the Rufi app shows a notice on your Mac. Click it to open that person's Follow-ups.

A notice shows only Rufi and a count, for example:

- **Rufi** · 1 follow-up is due
- **Rufi** · 2 follow-ups are overdue
- **Rufi** · 1 follow-up is due, 2 are overdue

It never shows a name or what the follow-up is, so nothing about your health shows on the lock screen. The details are in Rufi. When Rufi has more than one person, each person's follow-ups have their own notice, also without a name.

How notices work:

- The app checks as Rufi starts, then every 15 minutes, and when your Mac wakes. A follow-up that becomes due at midnight shows within 15 minutes, or when the Mac wakes.
- Each follow-up gets one notice when it becomes due and one when it becomes overdue, never more, also after Rufi starts again. If Rufi wasn't running on the day, you get one notice when it starts: "overdue" only, if the day has passed.
- A follow-up that is done or dropped before its day never gets a notice. A follow-up you reopen with the same date doesn't get its notices again; Needs you shows it.
- When you change the date, the follow-up gets new notices for the new date.
- The first time, macOS asks whether Rufi may show notifications. To turn them off, or to hide them on the lock screen, open **System Settings** › **Notifications** › **Rufi**.

When you don't get a notice:

- **Rufi isn't running:** the app tells you when it starts again.
- **Notifications are off, or a Focus is on:** the notice doesn't show, and Rufi doesn't try again. Needs you shows the follow-up.
- **Rufi runs in a browser only** (`pnpm start`), or the app opened on a Rufi that you started in the terminal: there are no notices. The pages show everything.
- **Rufi stopped at the moment it told you** (for example, it crashed): that notice is lost. Needs you shows the follow-up, and the overdue notice still comes.
- **You restored an older backup:** a notice you already had can show again (see [Backups and export](backups-and-export.md#restore-a-backup)).
