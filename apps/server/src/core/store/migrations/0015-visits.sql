-- A Visit is the record of a care event that happened (docs/adr/0021): a
-- clinic, online or home visit, or a hospital stay. It keeps the doctor's
-- words as written; the records saved from it cite it as a source. The
-- prescription kind and the care event type visit go: every reference to
-- one is retired first, since the readers expect each kind they meet to
-- exist and a foreign key doesn't check a kind and id. A save's receipt
-- stays in the chat as written, and its other changes stay. The backup
-- made before the upgrade keeps them all.
CREATE TABLE visits (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  setting TEXT NOT NULL DEFAULT 'unknown' CHECK (setting IN ('clinic', 'online', 'home', 'hospital', 'unknown')),
  date TEXT,
  date_words TEXT,
  ended TEXT,
  ended_words TEXT,
  doctor TEXT,
  place TEXT,
  reason TEXT,
  as_written TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id)
) STRICT;

CREATE TEMP TABLE retired (kind TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (kind, id));
INSERT INTO retired SELECT 'prescription', id FROM prescriptions;
INSERT INTO retired SELECT 'care_event', id FROM care_events WHERE type = 'visit';

DELETE FROM record_sources
  WHERE EXISTS (SELECT 1 FROM retired r WHERE r.kind = record_sources.kind AND r.id = record_sources.record_id);
DELETE FROM record_changes
  WHERE EXISTS (SELECT 1 FROM retired r WHERE r.kind = record_changes.kind AND r.id = record_changes.record_id);

-- A follow-up about a retired record is about nothing now, in its history
-- too, so the reverse of an old change of it names no gone record.
UPDATE follow_ups SET linked_kind = NULL, linked_id = NULL
  WHERE EXISTS (SELECT 1 FROM retired r WHERE r.kind = follow_ups.linked_kind AND r.id = follow_ups.linked_id);
UPDATE record_changes SET before = json_set(before, '$.linked_kind', NULL, '$.linked_id', NULL)
  WHERE kind = 'follow_up' AND before IS NOT NULL
    AND EXISTS (SELECT 1 FROM retired r WHERE r.kind = record_changes.before ->> '$.linked_kind' AND r.id = record_changes.before ->> '$.linked_id');
UPDATE record_changes SET after = json_set(after, '$.linked_kind', NULL, '$.linked_id', NULL)
  WHERE kind = 'follow_up'
    AND EXISTS (SELECT 1 FROM retired r WHERE r.kind = record_changes.after ->> '$.linked_kind' AND r.id = record_changes.after ->> '$.linked_id');

-- A brief keeps its words; its Sources no longer list a retired record.
UPDATE briefs SET cited = (
    SELECT json_group_array(json(value)) FROM (
      SELECT value FROM json_each(briefs.cited) c
      WHERE NOT EXISTS (SELECT 1 FROM retired r WHERE r.kind = c.value ->> '$.kind' AND r.id = c.value ->> '$.id')
      ORDER BY key
    )
  )
  WHERE EXISTS (
    SELECT 1 FROM json_each(briefs.cited) c JOIN retired r ON r.kind = c.value ->> '$.kind' AND r.id = c.value ->> '$.id'
  );

DROP TABLE retired;
DROP TABLE prescriptions;

-- A care event is a procedure or an immunisation.
CREATE TABLE care_events_new (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  type TEXT NOT NULL CHECK (type IN ('procedure', 'immunisation')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('planned', 'done', 'not_done', 'unknown')),
  date TEXT,
  date_words TEXT,
  provider TEXT,
  details TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id)
) STRICT;

INSERT INTO care_events_new
  SELECT id, person_id, type, name, status, date, date_words, provider, details, removed
  FROM care_events WHERE type != 'visit' ORDER BY rowid;

DROP TABLE care_events;
ALTER TABLE care_events_new RENAME TO care_events;

-- A record's sources gain a Visit: any record can cite any number of them.
CREATE TABLE record_sources_new (
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('message', 'document_page', 'visit')),
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
  CHECK ((type = 'visit') = (visit_id IS NOT NULL))
) STRICT;

INSERT INTO record_sources_new (person_id, kind, record_id, type, entry_id, document_id, page, operation_id, removed_by)
  SELECT person_id, kind, record_id, type, entry_id, document_id, page, operation_id, removed_by
  FROM record_sources ORDER BY rowid;

DROP TABLE record_sources;
ALTER TABLE record_sources_new RENAME TO record_sources;
CREATE INDEX sources_by_record ON record_sources (person_id, record_id);
CREATE INDEX sources_by_visit ON record_sources (person_id, visit_id);
