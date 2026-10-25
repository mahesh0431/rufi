-- Files start on Send (docs/adr/0022). A document is unsent while it sits
-- in the chat box (documents.sent_at null); every document made before was
-- sent as it was added. A reply whose message brings documents to read
-- starts with Rufi's part, before the agent's turn exists, so a turn's
-- agent turn and thread may be null; the reader copying a document is an
-- activity of the reply ('reading'). A message whose reply ended in Rufi's
-- part waits with a hold of its own ('reply_ended'). Rufi AI sorts in the
-- person's reply, so Rufi's sorting requests go: an open one's note leaves
-- the queue, and its file shows not sorted yet. The tables are made again,
-- as SQLite does it: new table, copy, drop, rename.
UPDATE chat_queue SET state = 'removed', held = NULL, hold_id = NULL, held_text = NULL
  WHERE state IN ('waiting', 'handing_over', 'not_sure')
    AND id IN (SELECT queue_id FROM sort_requests WHERE state = 'open' AND queue_id IS NOT NULL);
DROP TABLE sort_requests;

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
  sent_at TEXT,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, from_document) REFERENCES documents (person_id, id)
) STRICT;

INSERT INTO documents_new (id, person_id, added_at, added_from, kind, date, issuer, report_number, reader_note, version, deleted_at, from_document, sent_at)
  SELECT id, person_id, added_at, added_from, kind, date, issuer, report_number, reader_note, version, deleted_at, from_document, added_at
  FROM documents ORDER BY rowid;

DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;
CREATE INDEX documents_by_added ON documents (person_id, added_at);
CREATE INDEX documents_by_add ON documents (person_id, from_document);

CREATE TABLE turns_new (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  agent_turn_id TEXT,
  thread_id TEXT,
  model TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'person' CHECK (origin IN ('person', 'rufi')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'interrupted', 'failed')),
  end_reason TEXT CHECK (end_reason IN ('stopped', 'timeout', 'usage_limit', 'rate_limit', 'sign_in', 'connection', 'provider_failed', 'save_failed')),
  end_text TEXT,
  resets_at TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (person_id, id),
  UNIQUE (chat_id, agent_turn_id),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id)
) STRICT;

INSERT INTO turns_new (id, person_id, chat_id, agent_turn_id, thread_id, model, origin, status, end_reason, end_text, resets_at, started_at, ended_at)
  SELECT id, person_id, chat_id, agent_turn_id, thread_id, model, origin, status, end_reason, end_text, resets_at, started_at, ended_at
  FROM turns ORDER BY rowid;

DROP TABLE turns;
ALTER TABLE turns_new RENAME TO turns;
CREATE INDEX turns_by_chat ON turns (person_id, chat_id, started_at);
CREATE INDEX turns_by_status ON turns (status);

CREATE TABLE transcript_entries_new (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  turn_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'steer', 'activity', 'reply', 'reasoning', 'receipt', 'event', 'brief')),
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
  UNIQUE (person_id, id),
  UNIQUE (chat_id, seq),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id),
  FOREIGN KEY (person_id, turn_id) REFERENCES turns (person_id, id),
  CHECK ((kind = 'activity') = (activity IS NOT NULL)),
  CHECK (kind != 'activity' OR status IS NOT NULL),
  CHECK (status IS NULL OR kind IN ('activity', 'reply')),
  CHECK (details IS NULL OR kind IN ('activity', 'reasoning', 'event')),
  CHECK (refs IS NULL OR kind IN ('message', 'steer'))
) STRICT;

INSERT INTO transcript_entries_new (id, person_id, chat_id, seq, turn_id, kind, text, activity, detail, details, refs, status, agent_item_id, revision, created_at, updated_at)
  SELECT id, person_id, chat_id, seq, turn_id, kind, text, activity, detail, details, refs, status, agent_item_id, revision, created_at, updated_at
  FROM transcript_entries ORDER BY rowid;

DROP TABLE transcript_entries;
ALTER TABLE transcript_entries_new RENAME TO transcript_entries;
CREATE INDEX entries_by_turn ON transcript_entries (person_id, turn_id);

CREATE TABLE chat_queue_new (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('person', 'rufi')),
  text TEXT NOT NULL,
  refs TEXT NOT NULL DEFAULT '[]',
  event_id TEXT,
  position INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'handing_over', 'sent', 'not_sure', 'removed')),
  held TEXT CHECK (held IN ('paused', 'signed_out', 'restored', 'failed', 'open_failed', 'reply_ended')),
  held_text TEXT,
  hold_id TEXT,
  sent_as TEXT,
  turn_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id),
  FOREIGN KEY (person_id, event_id) REFERENCES transcript_entries (person_id, id),
  FOREIGN KEY (person_id, turn_id) REFERENCES turns (person_id, id),
  CHECK ((origin = 'rufi') = (event_id IS NOT NULL)),
  CHECK (held IS NULL OR state = 'waiting'),
  CHECK ((held IS 'open_failed' OR held IS 'reply_ended') = (hold_id IS NOT NULL))
) STRICT;

INSERT INTO chat_queue_new (id, person_id, chat_id, origin, text, refs, event_id, position, state, held, held_text, hold_id, sent_as, turn_id, created_at, updated_at)
  SELECT id, person_id, chat_id, origin, text, refs, event_id, position, state, held, held_text, hold_id, sent_as, turn_id, created_at, updated_at
  FROM chat_queue ORDER BY rowid;

DROP TABLE chat_queue;
ALTER TABLE chat_queue_new RENAME TO chat_queue;
CREATE INDEX queue_by_chat ON chat_queue (person_id, chat_id, state, position);
