-- Rufi's one database. Connections must run `PRAGMA foreign_keys = ON`.
--
-- Person scope is a relation, not just a column: every person-owned row carries
-- person_id, and references between person-owned rows go through composite
-- foreign keys (person_id, id), so a row for one person can never point at
-- another person's row. File bytes are shared and carry no person.
--
-- Dates are text at the precision they were known: 'YYYY', 'YYYY-MM' or
-- 'YYYY-MM-DD' (times as ISO 8601). Values are stored as printed.

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL
) STRICT;

-- Deduplicated original bytes, shared across people.
CREATE TABLE files (
  id TEXT PRIMARY KEY,   -- sha256 of the bytes, hex
  size INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  file_id TEXT NOT NULL REFERENCES files (id),
  original_name TEXT NOT NULL,
  added_at TEXT NOT NULL,
  UNIQUE (person_id, id),
  UNIQUE (person_id, file_id) -- the same bytes for the same person reuse the document
) STRICT;

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  issuer TEXT,           -- lab or clinic, as printed
  collected TEXT,        -- precision date
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, document_id) REFERENCES documents (person_id, id)
) STRICT;

CREATE TABLE results (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  report_id TEXT,        -- null when typed in rather than read from a report
  test_name TEXT NOT NULL,     -- as printed
  value_text TEXT NOT NULL,    -- as printed, e.g. '<5', '6.8', 'Negative'
  comparator TEXT,             -- '<', '<=', '>' or '>=' when printed; '<5' is not 5
  value_number REAL,           -- the plain number, when there is one
  unit TEXT,                   -- as printed
  reference_range TEXT,        -- as printed
  flag_text TEXT,              -- 'High' / 'Low' only as printed; Rufi adds none
  context_text TEXT,           -- method or context as printed, e.g. 'Calculated', 'Fasting'
  measured_at TEXT,            -- when the sample was taken (precision date or time)
  entered_at TEXT NOT NULL,    -- when it entered Rufi
  replaces_id TEXT,            -- an amended result points at the one it replaces
  group_label TEXT,            -- a shared label to join two printed names; printed fields never change
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, report_id) REFERENCES reports (person_id, id),
  FOREIGN KEY (person_id, replaces_id) REFERENCES results (person_id, id)
) STRICT;

CREATE INDEX documents_by_file ON documents (file_id);
CREATE INDEX reports_by_document ON reports (person_id, document_id);
CREATE INDEX results_by_report ON results (person_id, report_id);
CREATE INDEX results_by_test ON results (person_id, test_name, unit, measured_at);
CREATE INDEX results_by_replaced ON results (person_id, replaces_id); -- current results leave out replaced ones
