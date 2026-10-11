-- A document can be deleted (docs/adr/0015): its row and its pages' rows
-- stay as a tombstone, with the document's deleted time, its pages' names
-- and positions, and no file, so the history and the sources that point at
-- them still read. The original, the reader's work and the draft items go.
-- Both tables are made again, as SQLite does it: new table, copy, drop,
-- rename.
CREATE TABLE documents_new (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  added_at TEXT NOT NULL,
  added_from TEXT NOT NULL CHECK (added_from IN ('documents_page', 'chat')),
  kind TEXT CHECK (kind IN ('lab_report', 'prescription', 'letter', 'other')), -- as read; null until read
  date TEXT,             -- the document's date as read (precision date), when every page agrees; null until read
  reader_note TEXT,      -- the reader's one note for the whole document, rewritten by the reader
  version INTEGER NOT NULL DEFAULT 0, -- rises whenever its draft items change (a reading, a retry)
  deleted_at TEXT,       -- when the person deleted it: a tombstone, out of every list and action
  UNIQUE (person_id, id)
) STRICT;

INSERT INTO documents_new (id, person_id, added_at, added_from, kind, date, reader_note, version)
  SELECT id, person_id, added_at, added_from, kind, date, reader_note, version
  FROM documents ORDER BY rowid;

DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;
CREATE INDEX documents_by_added ON documents (person_id, added_at);

CREATE TABLE document_pages_new (
  person_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  position INTEGER NOT NULL,   -- 1, 2, 3... in the document
  file_id TEXT REFERENCES files (id), -- null once its document is deleted
  page_in_file INTEGER NOT NULL, -- 1, 2, 3... in the file
  file_name TEXT NOT NULL,     -- the file's name as it was added
  -- The reader's notebook: this page's entry (JSON, as save_page checked it)
  -- and the job that saved it. A later save_page for the page replaces it.
  entry TEXT,
  entry_job_id TEXT,
  entry_attempt INTEGER,      -- run that saved it; 0 if that run failed
  entry_at TEXT,
  entry_checks TEXT,           -- Rufi's checks of the entry (JSON): they flag, never change it
  -- What the page is once a reading that targeted it finished: its entry's
  -- outcome, or not_looked_at when it had none; null while it waits.
  state TEXT CHECK (state IN ('read', 'nothing_here', 'unreadable', 'not_looked_at')),
  state_why TEXT,              -- why it is unreadable
  PRIMARY KEY (person_id, document_id, position),
  UNIQUE (person_id, file_id, page_in_file),
  FOREIGN KEY (person_id, document_id) REFERENCES documents (person_id, id),
  FOREIGN KEY (person_id, entry_job_id) REFERENCES jobs (person_id, id)
) STRICT;

INSERT INTO document_pages_new
  SELECT person_id, document_id, position, file_id, page_in_file, file_name, entry,
         entry_job_id, entry_attempt, entry_at, entry_checks, state, state_why
  FROM document_pages ORDER BY rowid;

DROP TABLE document_pages;
ALTER TABLE document_pages_new RENAME TO document_pages;
