-- Open work (docs/adr/0016): what Rufi keeps for the person to come back
-- to, when it has no home of its own. An open item is a question the AI
-- asked the person, or a task the AI accepted that spans turns. Operational
-- state, not the record: no save writes it, it makes no receipt, and the
-- record's version doesn't change with it. Only the open work module
-- (core/work/open-work.ts) writes these tables.
CREATE TABLE open_items (
  id TEXT PRIMARY KEY,         -- UUIDv7
  person_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,       -- the chat it was asked in
  turn_id TEXT NOT NULL,       -- the reply that added it
  kind TEXT NOT NULL CHECK (kind IN ('question', 'task')), -- a question waits for the person, a task for the AI
  text TEXT NOT NULL,          -- complete in itself, as the AI wrote it
  refs TEXT NOT NULL DEFAULT '[]', -- what it is about (JSON): chips, as they were when it was added
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
  outcome TEXT,                -- why it closed, in words; null while open
  operation_id TEXT,           -- the save that answered it, when one did
  show_again_at TEXT,          -- Later: hidden until this time; only while open
  version INTEGER NOT NULL DEFAULT 1, -- rises with every change: its last change in open_item_changes
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id),
  FOREIGN KEY (person_id, turn_id) REFERENCES turns (person_id, id),
  FOREIGN KEY (person_id, operation_id) REFERENCES operations (person_id, id),
  CHECK ((status = 'open') = (closed_at IS NULL)),
  CHECK (status != 'open' OR (outcome IS NULL AND operation_id IS NULL)),
  CHECK (show_again_at IS NULL OR status = 'open'),
  CHECK (operation_id IS NULL OR status = 'done')
) STRICT;

-- Every change to an open item, in order (version 1 is its add): who made
-- it, and what the item was after it. A reopen clears the item's closure;
-- the earlier one stays here. An AI change keeps its chat, call and turn:
-- the same call again returns this change, and is never a second one.
CREATE TABLE open_item_changes (
  person_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  version INTEGER NOT NULL,    -- the item's version after it: 1, 2, 3...
  at TEXT NOT NULL,
  by TEXT NOT NULL CHECK (by IN ('ai', 'person')),
  change TEXT NOT NULL CHECK (change IN ('added', 'later', 'brought_back', 'done', 'dropped', 'reopened')),
  chat_id TEXT,                -- an AI change: its chat
  call_id TEXT,                -- an AI change: the agent's id for the call
  turn_id TEXT,                -- an AI change: the reply that made it
  request TEXT,                -- an AI change: what the AI sent (JSON)
  status TEXT NOT NULL CHECK (status IN ('open', 'done', 'dropped')),
  show_again_at TEXT,
  outcome TEXT,
  operation_id TEXT,
  PRIMARY KEY (person_id, item_id, version),
  UNIQUE (chat_id, call_id),
  FOREIGN KEY (person_id, item_id) REFERENCES open_items (person_id, id),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id),
  FOREIGN KEY (person_id, turn_id) REFERENCES turns (person_id, id),
  FOREIGN KEY (person_id, operation_id) REFERENCES operations (person_id, id),
  CHECK ((by = 'ai') = (chat_id IS NOT NULL AND call_id IS NOT NULL AND turn_id IS NOT NULL AND request IS NOT NULL)),
  CHECK (by = 'ai' OR (chat_id IS NULL AND call_id IS NULL AND turn_id IS NULL AND request IS NULL))
) STRICT;

CREATE INDEX open_items_by_status ON open_items (person_id, status, created_at);
