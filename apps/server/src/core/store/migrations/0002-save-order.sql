-- The order of saves: operations.seq, from the order Rufi stored them in
-- (rowid, which a VACUUM may renumber). The table is made again with the
-- new column, as SQLite does it: new table, copy, drop, rename.
CREATE TABLE operations_new (
  id TEXT PRIMARY KEY,         -- UUIDv7
  seq INTEGER NOT NULL UNIQUE, -- 1, 2, 3...: set by the save in its transaction
  person_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  call_id TEXT NOT NULL,       -- the agent's id for the call: the same call again is the same save
  request TEXT NOT NULL,       -- the changes as the AI sent them (JSON)
  created_at TEXT NOT NULL,
  UNIQUE (person_id, id),
  UNIQUE (chat_id, call_id),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id)
) STRICT;

INSERT INTO operations_new (id, seq, person_id, chat_id, call_id, request, created_at)
  SELECT id, ROW_NUMBER() OVER (ORDER BY rowid), person_id, chat_id, call_id, request, created_at
  FROM operations ORDER BY rowid;

DROP TABLE operations;
ALTER TABLE operations_new RENAME TO operations;
CREATE INDEX operations_by_person ON operations (person_id, seq);
