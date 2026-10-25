-- Device data (docs/adr/0023): what a person's devices and apps measured,
-- outside the record. A device source is a connection bound to one person
-- for good; a batch is one page a source sent, kept as it came (gzip), with
-- its conversion's state; a device value is one thing measured, in Rufi's
-- terms, keyed by the source system's own ID. New tables only: nothing that
-- exists changes.
CREATE TABLE device_sources (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  system TEXT NOT NULL CHECK (system IN ('apple_health')),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_batch_at TEXT,
  UNIQUE (person_id, id),
  UNIQUE (person_id, id, system)
) STRICT;

CREATE TABLE device_batches (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  seq INTEGER NOT NULL UNIQUE,
  sender_batch_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  body BLOB NOT NULL,
  body_sha256 TEXT NOT NULL,
  body_bytes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'done', 'failed')),
  tries INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT,
  reason TEXT,
  done_at TEXT,
  counts TEXT,
  skipped TEXT,
  UNIQUE (person_id, id),
  UNIQUE (source_id, sender_batch_id),
  FOREIGN KEY (person_id, source_id) REFERENCES device_sources (person_id, id),
  CHECK ((status = 'done') = (done_at IS NOT NULL))
) STRICT;

CREATE TABLE device_values (
  person_id TEXT NOT NULL,
  system TEXT NOT NULL,
  external_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  type TEXT NOT NULL,
  value REAL NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  utc_offset INTEGER,
  time_zone TEXT,
  device TEXT,
  context TEXT,
  series TEXT,
  batch_id TEXT,
  removed_at TEXT,
  PRIMARY KEY (person_id, system, external_id),
  FOREIGN KEY (person_id, source_id, system) REFERENCES device_sources (person_id, id, system),
  FOREIGN KEY (person_id, batch_id) REFERENCES device_batches (person_id, id)
) STRICT, WITHOUT ROWID;

CREATE INDEX device_batches_by_status ON device_batches (status, seq);
CREATE INDEX device_batches_by_done ON device_batches (done_at);
CREATE INDEX device_values_by_type ON device_values (person_id, type, start_at);
CREATE INDEX device_values_by_batch ON device_values (person_id, batch_id) WHERE batch_id IS NOT NULL;
