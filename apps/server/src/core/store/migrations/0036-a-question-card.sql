-- Rufi AI can ask the person with a question card (its ask tool): an entry
-- of its own ('question') with the card as Rufi AI gave it (card) and, once
-- a click on it went to Rufi AI, which message chose which answer (answer).
-- The table is made again, as SQLite does it: new table, copy, drop, rename.
CREATE TABLE transcript_entries_new (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  turn_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'steer', 'activity', 'reply', 'reasoning', 'receipt', 'event', 'brief', 'agent', 'question')),
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
  card TEXT,
  answer TEXT,
  UNIQUE (person_id, id),
  UNIQUE (chat_id, seq),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id),
  FOREIGN KEY (person_id, turn_id) REFERENCES turns (person_id, id),
  CHECK ((kind = 'activity') = (activity IS NOT NULL)),
  CHECK (kind != 'activity' OR status IS NOT NULL),
  CHECK (status IS NULL OR kind IN ('activity', 'reply')),
  CHECK (details IS NULL OR kind IN ('activity', 'reasoning', 'event', 'agent')),
  CHECK (kind != 'agent' OR details IS NOT NULL),
  CHECK (refs IS NULL OR kind IN ('message', 'steer')),
  CHECK ((kind = 'question') = (card IS NOT NULL)),
  CHECK (answer IS NULL OR kind = 'question')
) STRICT;

INSERT INTO transcript_entries_new (id, person_id, chat_id, seq, turn_id, kind, text, activity, detail, details, refs, status, agent_item_id, revision, created_at, updated_at, questions)
  SELECT id, person_id, chat_id, seq, turn_id, kind, text, activity, detail, details, refs, status, agent_item_id, revision, created_at, updated_at, questions
  FROM transcript_entries ORDER BY rowid;

DROP TABLE transcript_entries;
ALTER TABLE transcript_entries_new RENAME TO transcript_entries;
CREATE INDEX entries_by_turn ON transcript_entries (person_id, turn_id);
