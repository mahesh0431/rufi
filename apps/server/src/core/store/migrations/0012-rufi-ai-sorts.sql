-- Rufi AI sorts each read add into documents and writes its drafts, from
-- the reader's page copies (docs/adr/0019). A document made by a split
-- points back at the add it came from (from_document), and keeps the
-- report Rufi AI said it is (issuer, report_number). A reading keeps when
-- Rufi AI sorted the pages it copied (sorted_at). A draft keeps the text it
-- came from on its page (quote). Each draft an older Rufi made keeps the
-- report and date Rufi's own guesses gave it (report), so it saves exactly
-- as before once those guesses are gone. Sorting requests are new. The
-- three tables are made again, as SQLite does it: new table, copy, drop,
-- rename.
CREATE TABLE documents_new (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  added_at TEXT NOT NULL,
  added_from TEXT NOT NULL CHECK (added_from IN ('documents_page', 'chat')),
  kind TEXT CHECK (kind IN ('lab_report', 'prescription', 'letter', 'other')),
  date TEXT,
  issuer TEXT,
  report_number TEXT,
  reader_note TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  from_document TEXT,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, from_document) REFERENCES documents (person_id, id)
) STRICT;

INSERT INTO documents_new (id, person_id, added_at, added_from, kind, date, reader_note, version, deleted_at)
  SELECT id, person_id, added_at, added_from, kind, date, reader_note, version, deleted_at
  FROM documents ORDER BY rowid;

DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;
CREATE INDEX documents_by_added ON documents (person_id, added_at);
CREATE INDEX documents_by_add ON documents (person_id, from_document);

-- A reading that ended before Rufi AI sorted counts as sorted: nothing old
-- is sorted by itself. One that hasn't ended yet is sorted when it ends.
CREATE TABLE jobs_new (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('document_read')),
  document_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  targets TEXT NOT NULL,
  retries INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT,
  started_at TEXT,
  run_at TEXT,
  ended_at TEXT,
  error TEXT,
  usage TEXT,
  reader TEXT,
  sorted_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, document_id) REFERENCES documents (person_id, id)
) STRICT;

INSERT INTO jobs_new (id, person_id, kind, document_id, state, attempt,
    targets, retries, retry_at, started_at, run_at, ended_at, error, usage,
    reader, sorted_at, created_at)
  SELECT id, person_id, kind, document_id, state, attempt, targets, retries,
    retry_at, started_at, run_at, ended_at, error, usage, reader,
    CASE WHEN state = 'done' THEN COALESCE(ended_at, created_at) END,
    created_at
  FROM jobs ORDER BY rowid;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
CREATE INDEX jobs_by_state ON jobs (state, created_at);
CREATE INDEX jobs_by_document ON jobs (person_id, document_id, created_at);

CREATE TABLE draft_items_new (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('lab_result')),
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'saved', 'dismissed')),
  fields TEXT NOT NULL,
  original TEXT NOT NULL,
  unsure TEXT NOT NULL DEFAULT '[]',
  quote TEXT,
  report TEXT,
  saved_as TEXT CHECK (saved_as IN ('new', 'another_source', 'correction')),
  record_kind TEXT,
  record_id TEXT,
  operation_id TEXT,
  dismissed_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, document_id, page) REFERENCES document_pages (person_id, document_id, position),
  FOREIGN KEY (person_id, job_id) REFERENCES jobs (person_id, id),
  FOREIGN KEY (person_id, operation_id) REFERENCES operations (person_id, id),
  CHECK ((status = 'saved') = (operation_id IS NOT NULL)),
  CHECK ((status = 'dismissed') = (dismissed_by IS NOT NULL))
) STRICT;

-- An older draft's report: what the page it is on prints (its lab, report
-- number and first date), or, for a page that prints none of them, the
-- nearest page before it that does, as Rufi worked it out until now.
INSERT INTO draft_items_new (id, person_id, document_id, page, seq, job_id,
    kind, version, status, fields, original, unsure, quote, report, saved_as,
    record_kind, record_id, operation_id, dismissed_by, created_at)
  SELECT d.id, d.person_id, d.document_id, d.page, d.seq, d.job_id, d.kind,
    d.version, d.status, d.fields, d.original, d.unsure, NULL,
    (SELECT json_object(
        'issuer', json_extract(p.entry, '$.facts.issuer'),
        'number', json_extract(p.entry, '$.facts.report_number'),
        'collected', json_extract(p.entry, '$.facts.dates[0].iso'),
        'date', json(json_extract(p.entry, '$.facts.dates[0]')))
      FROM document_pages p
      WHERE p.person_id = d.person_id AND p.document_id = d.document_id
        AND p.position <= d.page AND p.entry IS NOT NULL
        AND (json_extract(p.entry, '$.facts.issuer') IS NOT NULL
          OR json_extract(p.entry, '$.facts.report_number') IS NOT NULL
          OR json_extract(p.entry, '$.facts.dates[0]') IS NOT NULL)
      ORDER BY p.position DESC LIMIT 1),
    d.saved_as, d.record_kind, d.record_id, d.operation_id, d.dismissed_by,
    d.created_at
  FROM draft_items d ORDER BY d.rowid;

UPDATE draft_items_new SET report = json_object('issuer', NULL, 'number', NULL, 'collected', NULL, 'date', NULL)
  WHERE report IS NULL;

DROP TABLE draft_items;
ALTER TABLE draft_items_new RENAME TO draft_items;
CREATE INDEX drafts_by_document ON draft_items (person_id, document_id, page, seq);

CREATE TABLE sort_requests (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  job_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'asked', 'failed', 'done', 'void')),
  queue_id TEXT,
  tries INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT,
  error TEXT,
  call_id TEXT,
  answer TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (person_id, id),
  UNIQUE (person_id, call_id),
  FOREIGN KEY (person_id, document_id) REFERENCES documents (person_id, id),
  FOREIGN KEY (person_id, job_id) REFERENCES jobs (person_id, id),
  FOREIGN KEY (person_id, queue_id) REFERENCES chat_queue (person_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((state = 'done') = (call_id IS NOT NULL))
) STRICT;

CREATE INDEX sort_requests_by_state ON sort_requests (state, retry_at);
CREATE INDEX sort_requests_by_document ON sort_requests (person_id, document_id);
CREATE INDEX sort_requests_by_queue ON sort_requests (person_id, queue_id);
