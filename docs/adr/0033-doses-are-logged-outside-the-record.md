# 0033 · Doses are logged outside the record

**Date:** 2 Nov 2026 · **Status:** accepted

A person says what happened to a dose of a medicine: they took it, or skipped it. They say it in one tap, from Today on the Mac, and later from a notice on their iPhone, often while the Mac can't be reached, and they can take it back. The record's saves don't fit that: a save needs the chat and a yes (ADR 0005), and a phone away from the Mac can't make one.

**The dose log is its own table, outside the record.** `dose_log` (migration 32) keeps one row per log: the medicine use, the dose (its local date and time, `YYYY-MM-DDTHH:MM`, as rung or shown), the state (`taken`, `skipped`, or `cleared` for an undo), when it was taken when the person said, when it was logged on the device they used (`logged_at`), when Rufi stored it (`received_at`) and who logged it (`mac`, `rufi_ai`, or `app:<paired app id>`). No `operations`, `record_changes`, `record_sources` or receipts; the record's version doesn't move. Like device data (ADR 0023), it is kept as it came, and its rows are the trace: a row is never changed or removed, and an undo is a new row.

**A log's id is made where it was logged, and kept across a retry.** `POST /api/people/:personId/doses` stores a log and answers 201. The same id again is 200 only when it is the same person and the same log (medicine, dose, state, taken and logged times); another log under that id, also another person's, is 409, and nothing is stored. Who sent it and when it arrived aren't compared, so a phone paired again can send a waiting log once more. A medicine use that isn't the person's is 404. Today's buttons make the id when pressed and send the same log again on **Try again** when an answer was lost; Rufi AI's tool will use its call's id.

**A dose's state is its log with the latest `logged_at`**, then `received_at`, so a log made offline sits in its place when it arrives later. With no log, or an undo last, a dose is **not logged**: never "missed". Code decides nothing else about a log: it doesn't check that a dose was due, since a log made before a medicine's times changed must still arrive.

**The rows are the history.** `GET /api/people/:personId/doses?from&to[&medicine]` gives the rows for doses on those local days (at most 62), with each medicine's name as it is now, also for a stopped or removed one. Rufi works out no expected doses for past days and no count of them: the times may have changed since. Today uses the current times and shows each dose's latest log. Only scheduled doses are logged for now.

**Open screens hear of each log.** Each stored log sends `{ type: "doses" }` on the person's chat stream; the screens read Today and the dose log again. A retry that stores nothing sends nothing.

The reason: a log is the person's own word about one moment, made in one tap and often offline, and a retry must never double it; keeping it apart lets it come in without a chat and leaves the record's guarantees as they are. The cost: a log has no receipt or undo through the record (Undo is another log), a log on the wrong dose stays in the history beside its undo, and a dose with no log can't be told apart from one not taken.
