-- A picture the AI generated is a line of the chat's transcript of its own
-- kind (activity 'picture'), with its path whole in detail, so a reply
-- shows it. The table is made again, as SQLite does it: new table, copy,
-- drop, rename.
CREATE TABLE transcript_entries_new (
  id TEXT PRIMARY KEY,         -- UUIDv7; a message keeps the id the agent got with it
  person_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  seq INTEGER NOT NULL,        -- 1, 2, 3... in the chat
  turn_id TEXT,                -- the reply it belongs to
  kind TEXT NOT NULL CHECK (kind IN ('message', 'steer', 'activity', 'reply', 'reasoning', 'receipt', 'event', 'brief')),
  text TEXT NOT NULL,          -- the message or the reply as it came; an activity's short title; the reasoning's summary; a receipt's, an event's or a brief's line
  activity TEXT CHECK (activity IN ('tool', 'command', 'web_search', 'file_change', 'sub_agent', 'compaction', 'picture', 'other')),
  detail TEXT,                 -- an activity's one short detail: the query, the search words, the command; a picture's path, whole
  details TEXT,                -- an activity's or reasoning's everything, as the agent gave it (JSON); an event's kind and facts (JSON); null: none
  refs TEXT,                   -- a message's references, its chips (JSON); null: none
  status TEXT CHECK (status IN ('running', 'done', 'failed', 'stopped')),
  agent_item_id TEXT,          -- the agent's id for a reply or an activity, to update it
  revision INTEGER NOT NULL,   -- the chat's revision when it last changed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (person_id, id),
  UNIQUE (chat_id, seq),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id),
  FOREIGN KEY (person_id, turn_id) REFERENCES turns (person_id, id),
  -- An activity line has its kind and status; nothing else has either.
  CHECK ((kind = 'activity') = (activity IS NOT NULL) AND (kind = 'activity') = (status IS NOT NULL)),
  CHECK (details IS NULL OR kind IN ('activity', 'reasoning', 'event')),
  CHECK (refs IS NULL OR kind IN ('message', 'steer'))
) STRICT;

INSERT INTO transcript_entries_new (id, person_id, chat_id, seq, turn_id, kind, text, activity, detail, details, refs, status, agent_item_id, revision, created_at, updated_at)
  SELECT id, person_id, chat_id, seq, turn_id, kind, text, activity, detail, details, refs, status, agent_item_id, revision, created_at, updated_at
  FROM transcript_entries ORDER BY rowid;

DROP TABLE transcript_entries;
ALTER TABLE transcript_entries_new RENAME TO transcript_entries;
CREATE INDEX entries_by_turn ON transcript_entries (person_id, turn_id);
