-- Each result belongs to one of the person's tests (docs/adr/0028), which
-- the AI chooses when it saves, with its number in the test's unit; the Lab
-- results page lists the tests and draws a test's line from those numbers.
-- The results saved before this get one test for each of today's lines: one
-- per person, printed name, category and printed unit, named as printed,
-- with no section and that unit, so each result's numbers are already in
-- its test's unit and are copied. That is how Rufi joined them before, a
-- compatibility value and not a judgement; the person can ask the AI to
-- join or rename them. A test's id is its first result's, after 't-'. The
-- shared label results never used goes. Old history and receipts stay as
-- they were. The results table is made again, as SQLite does it: new
-- table, copy, drop, rename.
CREATE TABLE tests (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  name TEXT NOT NULL,          -- the AI's plain name for it, e.g. 'Creatinine'
  section TEXT,                -- the AI's words, e.g. 'Kidney'; none shows last
  unit TEXT,                   -- the unit its line uses, as the AI gave it; none for a test with no unit
  removed INTEGER NOT NULL DEFAULT 0, -- always 0: a test is never removed
  UNIQUE (person_id, id)
) STRICT;

-- Each result's line before this: its first result, in the order saved.
CREATE TEMP TABLE line_of AS
  SELECT r.id AS result_id,
         (SELECT 't-' || o.id FROM results o
            WHERE o.person_id = r.person_id AND o.test_name = r.test_name
              AND o.category = r.category AND o.unit IS r.unit
            ORDER BY o.rowid LIMIT 1) AS test_id
  FROM results r;

INSERT INTO tests (id, person_id, name, unit)
  SELECT 't-' || r.id, r.person_id, r.test_name, r.unit FROM results r
  WHERE 't-' || r.id IN (SELECT test_id FROM line_of)
  ORDER BY r.rowid;

CREATE TABLE results_new (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  report_id TEXT,        -- null when typed in rather than read from a report
  category TEXT NOT NULL CHECK (category IN ('lab', 'measurement')), -- the AI's choice with the person; the pages filter by it
  test_name TEXT NOT NULL,     -- as printed
  test_id TEXT NOT NULL,       -- the person's test it belongs to, the AI's choice
  test_number REAL,            -- the AI's number for it in its test's unit; none: not on the test's line
  test_second_number REAL,     -- the same for its second number
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
  second_number REAL,          -- a two-value result's second number: a blood pressure '128/84' is 128 and 84
  measured_words TEXT,         -- the words for measured_at: the user's, or the date as printed with its label
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, report_id) REFERENCES reports (person_id, id),
  FOREIGN KEY (person_id, replaces_id) REFERENCES results (person_id, id),
  FOREIGN KEY (person_id, test_id) REFERENCES tests (person_id, id)
) STRICT;

INSERT INTO results_new (id, person_id, report_id, category, test_name, test_id, test_number,
                         test_second_number, value_text,
                         comparator, value_number, unit, reference_range, flag_text, context_text,
                         measured_at, entered_at, replaces_id, second_number, measured_words, removed)
  SELECT r.id, r.person_id, r.report_id, r.category, r.test_name, l.test_id, r.value_number,
         r.second_number, r.value_text,
         r.comparator, r.value_number, r.unit, r.reference_range, r.flag_text, r.context_text,
         r.measured_at, r.entered_at, r.replaces_id, r.second_number, r.measured_words, r.removed
  FROM results r JOIN line_of l ON l.result_id = r.id ORDER BY r.rowid;

DROP TABLE line_of;
DROP TABLE results;
ALTER TABLE results_new RENAME TO results;
CREATE INDEX results_by_report ON results (person_id, report_id);
CREATE INDEX results_by_test ON results (person_id, test_id, measured_at);
CREATE INDEX results_by_replaced ON results (person_id, replaces_id);
