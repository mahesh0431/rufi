-- A person's profile: their birth date, sex for lab ranges, blood group and
-- height, one row per person, made empty for everyone already here. It
-- changes only by a save, like the rest of the record, and a save can now
-- come from the welcome, the profile page or Settings as well as the chat:
-- operations says where (origin), keeps a form's receipt itself, and has a
-- chat only when it was made in one; a record's source can be what the
-- person entered in a form. Both tables are made again, as SQLite does it:
-- new table, copy, drop, rename.
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  birth_date TEXT,
  birth_date_words TEXT,
  sex_for_ranges TEXT CHECK (sex_for_ranges IN ('female', 'male')),
  blood_group TEXT CHECK (blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  height REAL,
  height_unit TEXT CHECK (height_unit IN ('cm', 'in')),
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id),
  CHECK (id = person_id)
) STRICT;

INSERT INTO profiles (id, person_id) SELECT id, id FROM people;

CREATE TABLE operations_new (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  person_id TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'chat' CHECK (origin IN ('chat', 'welcome', 'profile', 'settings')),
  chat_id TEXT,
  call_id TEXT NOT NULL,
  request TEXT NOT NULL,
  receipt TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (person_id, id),
  UNIQUE (person_id, call_id),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id),
  CHECK ((origin = 'chat') = (chat_id IS NOT NULL))
) STRICT;

INSERT INTO operations_new (id, seq, person_id, chat_id, call_id, request, created_at)
  SELECT id, seq, person_id, chat_id, call_id, request, created_at
  FROM operations ORDER BY seq;

DROP TABLE operations;
ALTER TABLE operations_new RENAME TO operations;
CREATE INDEX operations_by_person ON operations (person_id, seq);

CREATE TABLE record_sources_new (
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('message', 'document_page', 'visit', 'form')),
  entry_id TEXT,
  document_id TEXT,
  page INTEGER,
  visit_id TEXT,
  operation_id TEXT,
  removed_by TEXT,
  FOREIGN KEY (person_id, entry_id) REFERENCES transcript_entries (person_id, id),
  FOREIGN KEY (person_id, document_id, page) REFERENCES document_pages (person_id, document_id, position),
  FOREIGN KEY (person_id, visit_id) REFERENCES visits (person_id, id),
  FOREIGN KEY (person_id, operation_id) REFERENCES operations (person_id, id),
  FOREIGN KEY (person_id, removed_by) REFERENCES operations (person_id, id),
  CHECK ((type = 'message') = (entry_id IS NOT NULL)),
  CHECK ((type = 'document_page') = (document_id IS NOT NULL AND page IS NOT NULL)),
  CHECK ((type = 'visit') = (visit_id IS NOT NULL)),
  CHECK (type != 'form' OR operation_id IS NOT NULL)
) STRICT;

-- rowid kept: a record's sources are listed in the order they were added.
INSERT INTO record_sources_new (rowid, person_id, kind, record_id, type, entry_id, document_id, page, visit_id, operation_id, removed_by)
  SELECT rowid, person_id, kind, record_id, type, entry_id, document_id, page, visit_id, operation_id, removed_by
  FROM record_sources;

DROP TABLE record_sources;
ALTER TABLE record_sources_new RENAME TO record_sources;
CREATE INDEX sources_by_record ON record_sources (person_id, record_id);
CREATE INDEX sources_by_visit ON record_sources (person_id, visit_id);
