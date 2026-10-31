-- An agent's message to Rufi AI shows in the chat where Rufi AI took it,
-- as an entry of its own ('agent'): its words as the agent sent them, and
-- the agent, its name then and why it came (details). The small "why"
-- line over a reply Rufi AI gave by itself goes, and with it the turn's
-- cause: nobody uses Rufi yet, so older replies just lose that line. The
-- table is made again, as SQLite does it: new table, copy, drop, rename.
ALTER TABLE turns DROP COLUMN cause;

CREATE TABLE transcript_entries_new (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  turn_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'steer', 'activity', 'reply', 'reasoning', 'receipt', 'event', 'brief', 'agent')),
  text TEXT NOT NULL,
  activity TEXT CHECK (activity IN ('tool', 'command', 'web_search', 'file_change', 'sub_agent', 'compaction', 'picture', 'note', 'reading', 'other')),
  detail TEXT,
  details TEXT,
  refs TEXT,
  status TEXT CHECK (status IN ('running', 'done', 'failed', 'stopped')),
  agent_item_id TEXT,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  questions TEXT CHECK (questions IS NULL OR kind = 'reply'),
  UNIQUE (person_id, id),
  UNIQUE (chat_id, seq),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id),
  FOREIGN KEY (person_id, turn_id) REFERENCES turns (person_id, id),
  CHECK ((kind = 'activity') = (activity IS NOT NULL)),
  CHECK (kind != 'activity' OR status IS NOT NULL),
  CHECK (status IS NULL OR kind IN ('activity', 'reply')),
  CHECK (details IS NULL OR kind IN ('activity', 'reasoning', 'event', 'agent')),
  CHECK (kind != 'agent' OR details IS NOT NULL),
  CHECK (refs IS NULL OR kind IN ('message', 'steer'))
) STRICT;

INSERT INTO transcript_entries_new (id, person_id, chat_id, seq, turn_id, kind, text, activity, detail, details, refs, status, agent_item_id, revision, created_at, updated_at, questions)
  SELECT id, person_id, chat_id, seq, turn_id, kind, text, activity, detail, details, refs, status, agent_item_id, revision, created_at, updated_at, questions
  FROM transcript_entries ORDER BY rowid;

DROP TABLE transcript_entries;
ALTER TABLE transcript_entries_new RENAME TO transcript_entries;
CREATE INDEX entries_by_turn ON transcript_entries (person_id, turn_id);
