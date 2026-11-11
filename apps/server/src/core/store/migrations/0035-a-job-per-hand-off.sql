-- A job is a task Rufi AI handed to an agent: one per hand-off, working
-- from the start_agent or send_agent that gave it documents, until it is
-- done or ends with why. The older reader's states and its run columns go,
-- and so does the document's one reader (set_reader). A job that hadn't
-- finished ended: an older reader's failed one keeps its error. The table
-- is made again, as SQLite does it: new table, copy, drop, rename.
CREATE TABLE jobs_new (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('document_read')),
  agent_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('working', 'done', 'ended')),
  ended_why TEXT CHECK (ended_why IN ('not_started', 'no_save', 'stopped', 'failed', 'agent_lost', 'deleted')),
  document_id TEXT,
  targets TEXT,
  started_at TEXT,
  ended_at TEXT,
  error TEXT,
  usage TEXT,
  reader TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, document_id) REFERENCES documents (person_id, id),
  CHECK ((state = 'ended') = (ended_why IS NOT NULL)),
  CHECK ((kind = 'document_read') = (document_id IS NOT NULL AND targets IS NOT NULL))
) STRICT;

INSERT INTO jobs_new (id, person_id, kind, agent_id, state, ended_why,
    document_id, targets, started_at, ended_at, error, usage, reader,
    created_at)
  SELECT id, person_id, kind, NULL,
    CASE state WHEN 'done' THEN 'done' ELSE 'ended' END,
    CASE state WHEN 'done' THEN NULL ELSE 'failed' END,
    document_id, targets, started_at, COALESCE(ended_at, created_at), error,
    usage, reader, created_at
  FROM jobs ORDER BY rowid;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
CREATE INDEX jobs_by_agent ON jobs (agent_id, state);
CREATE INDEX jobs_by_document ON jobs (person_id, document_id, created_at);

ALTER TABLE documents DROP COLUMN reader_agent;
