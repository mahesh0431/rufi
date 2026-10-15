-- Keep the save's warnings, so replay returns the original local-date
-- comparison even after the Mac's time zone changes. Older saves have none.
CREATE TABLE operations_new (
  id TEXT PRIMARY KEY,         -- UUIDv7
  seq INTEGER NOT NULL UNIQUE, -- 1, 2, 3...: set by the save in its transaction
  person_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  call_id TEXT NOT NULL,       -- the agent's id for the call: the same call again is the same save
  request TEXT NOT NULL,       -- the changes as the AI sent them (JSON)
  warnings TEXT NOT NULL DEFAULT '[]', -- the warnings returned by the save (JSON)
  created_at TEXT NOT NULL,
  UNIQUE (person_id, id),
  UNIQUE (chat_id, call_id),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id)
) STRICT;

INSERT INTO operations_new (id, seq, person_id, chat_id, call_id, request, created_at)
  SELECT id, seq, person_id, chat_id, call_id, request, created_at
  FROM operations ORDER BY seq;

DROP TABLE operations;
ALTER TABLE operations_new RENAME TO operations;
CREATE INDEX operations_by_person ON operations (person_id, seq);
