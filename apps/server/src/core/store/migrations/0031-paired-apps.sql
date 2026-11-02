-- Paired apps (docs/adr/0032): an app, such as Rufi on an iPhone, given its
-- own key for one person for good. The Mac keeps only the key's hash. A
-- device source may belong to a paired app, of the same person only, so
-- device_sources is made again, as SQLite does it: new table, copy, drop,
-- rename. Its sources so far came from the import command: none has an app.
CREATE TABLE paired_apps (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  kind TEXT NOT NULL CHECK (kind IN ('iphone')),
  name TEXT NOT NULL,
  key_sha256 TEXT NOT NULL UNIQUE,
  paired_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT,
  UNIQUE (person_id, id)
) STRICT;

CREATE TABLE device_sources_new (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  system TEXT NOT NULL CHECK (system IN ('apple_health')),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_batch_at TEXT,
  paired_app_id TEXT,
  UNIQUE (person_id, id),
  UNIQUE (person_id, id, system),
  FOREIGN KEY (person_id, paired_app_id) REFERENCES paired_apps (person_id, id)
) STRICT;

INSERT INTO device_sources_new (id, person_id, system, name, created_at, last_batch_at)
  SELECT id, person_id, system, name, created_at, last_batch_at
  FROM device_sources ORDER BY rowid;

DROP TABLE device_sources;
ALTER TABLE device_sources_new RENAME TO device_sources;
