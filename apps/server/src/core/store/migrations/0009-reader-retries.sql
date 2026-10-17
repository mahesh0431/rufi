-- A reading no longer waits for the sign-in or a usage limit: it fails with
-- the reason, and the person retries it. A reading that failed for a
-- passing reason tries again by itself, up to three times, each after a
-- longer wait. The table is made again, as SQLite does it: new table, copy,
-- drop, rename. A reading that waited runs at the next start.
CREATE TABLE jobs_new (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('document_read')),
  document_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 0, -- 1, 2, 3... as runs start
  targets TEXT NOT NULL,               -- JSON array of page positions
  retries INTEGER NOT NULL DEFAULT 0,  -- automatic retries used since its start or the person's Retry
  retry_at TEXT,                       -- a queued automatic retry runs from then on
  started_at TEXT,                     -- its first real start: the chat's start line
  run_at TEXT,                         -- the current run's start
  ended_at TEXT,
  error TEXT,                          -- why it failed, in words for the person
  usage TEXT,                          -- its runs' AI use as the agent reported it, summed (JSON)
  reader TEXT,                         -- the reader version of its last run (JSON)
  created_at TEXT NOT NULL,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, document_id) REFERENCES documents (person_id, id)
) STRICT;

INSERT INTO jobs_new (id, person_id, kind, document_id, state, attempt,
    targets, retries, started_at, run_at, ended_at, error, usage, reader,
    created_at)
  SELECT id, person_id, kind, document_id, state, attempt, targets, retried,
    started_at, run_at, ended_at, error, usage, reader, created_at
  FROM jobs ORDER BY rowid;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
CREATE INDEX jobs_by_state ON jobs (state, created_at);
CREATE INDEX jobs_by_document ON jobs (person_id, document_id, created_at);
