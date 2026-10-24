-- Rufi AI and the person decide what code used to guess. A save no longer
-- warns about a date later than its message: the AI notices it, as its
-- skill says. An older draft no longer keeps the report and date an older
-- Rufi worked out for it: it saves as Rufi AI's drafts do, with its own
-- date and its document as its report.
ALTER TABLE operations DROP COLUMN warnings;
ALTER TABLE draft_items DROP COLUMN report;
