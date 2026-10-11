-- Every result has a category (docs/adr/0013): lab, a test of a sample, or
-- measurement, a reading such as blood pressure or weight. The AI chooses
-- it with the person when a result is saved; there is no default. Results
-- saved before this have none, so they get 'lab': a compatibility value
-- from before real data existed, not a judgement. Old history and receipts
-- stay as they were. The table is made again with the new column, as
-- SQLite does it: new table, copy, drop, rename.
CREATE TABLE results_new (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  report_id TEXT,        -- null when typed in rather than read from a report
  category TEXT NOT NULL CHECK (category IN ('lab', 'measurement')), -- the AI's choice with the person; the pages filter by it
  test_name TEXT NOT NULL,     -- as printed
  value_text TEXT NOT NULL,    -- as printed, e.g. '<5', '6.8', 'Negative'
  comparator TEXT,             -- '<', '<=', '>' or '>=' when printed; '<5' is not 5
  value_number REAL,           -- the plain number, when there is one
  unit TEXT,                   -- as printed
  reference_range TEXT,        -- as printed
  flag_text TEXT,              -- 'High' / 'Low' only as printed; Rufi adds none
  context_text TEXT,           -- method or context as printed, e.g. 'Calculated', 'Fasting'
  measured_at TEXT,            -- when the sample was taken, or the measurement made (precision date or time)
  entered_at TEXT NOT NULL,    -- when it entered Rufi
  replaces_id TEXT,            -- an amended result points at the one it replaces
  group_label TEXT,            -- a shared label to join two printed names; printed fields never change
  second_number REAL,          -- a two-value result's second number: a blood pressure '128/84' is 128 and 84
  measured_words TEXT,         -- the words for measured_at: the user's, or the date as printed with its label
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, report_id) REFERENCES reports (person_id, id),
  FOREIGN KEY (person_id, replaces_id) REFERENCES results (person_id, id)
) STRICT;

INSERT INTO results_new (id, person_id, report_id, category, test_name, value_text, comparator,
                         value_number, unit, reference_range, flag_text, context_text, measured_at,
                         entered_at, replaces_id, group_label, second_number, measured_words, removed)
  SELECT id, person_id, report_id, 'lab', test_name, value_text, comparator,
         value_number, unit, reference_range, flag_text, context_text, measured_at,
         entered_at, replaces_id, group_label, second_number, measured_words, removed
  FROM results ORDER BY rowid;

DROP TABLE results;
ALTER TABLE results_new RENAME TO results;
CREATE INDEX results_by_report ON results (person_id, report_id);
CREATE INDEX results_by_test ON results (person_id, test_name, unit, measured_at);
CREATE INDEX results_by_replaced ON results (person_id, replaces_id);
