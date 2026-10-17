-- The chat keeps how much of the model's context its thread used, as the
-- agent last reported it, and which thread that was, so a new thread never
-- shows the old one's. A message whose AI thread didn't open waits with its
-- own hold (open_failed) and that hold's id: Try again and New thread name
-- it, and a click on an older one changes nothing. Both tables are made
-- again, as SQLite does it: new table, copy, drop, rename.
CREATE TABLE chats_new (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL UNIQUE REFERENCES people (id), -- one chat per person
  model TEXT,                  -- the model chosen for it; null: the first allowed one, set when the first message goes
  effort TEXT CHECK (effort IN ('low', 'medium', 'high')), -- how hard the AI thinks, chosen for it; null: Rufi's default
  thread_id TEXT,              -- the agent's thread; none until the first message
  thread_provider TEXT,        -- whose thread it is, so another agent never reuses it
  thread_model TEXT,           -- the model the thread started with
  thread_tools TEXT,           -- the tool set it started with (a thread keeps its tools)
  paused TEXT CHECK (paused IN ('stopped', 'restarted')), -- nothing goes to the AI until the person sends: after a Stop, or Rufi started again with messages waiting
  revision INTEGER NOT NULL DEFAULT 0, -- grows with every change to the transcript
  context_tokens INTEGER,      -- the tokens of the thread's last request to the model, as the agent last reported them
  context_window INTEGER,      -- the model's context window then; null: the agent didn't say
  context_thread TEXT,         -- the thread they are of: shown only while it is the chat's thread
  created_at TEXT NOT NULL,
  UNIQUE (person_id, id)
) STRICT;

INSERT INTO chats_new (id, person_id, model, effort, thread_id, thread_provider, thread_model, thread_tools, paused, revision, created_at)
  SELECT id, person_id, model, effort, thread_id, thread_provider, thread_model, thread_tools, paused, revision, created_at
  FROM chats ORDER BY rowid;

DROP TABLE chats;
ALTER TABLE chats_new RENAME TO chats;

CREATE TABLE chat_queue_new (
  id TEXT PRIMARY KEY,         -- UUIDv7, given by the send: the acceptance identity; a person's message keeps it in the transcript
  person_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('person', 'rufi')),
  text TEXT NOT NULL,          -- the person's message, or Rufi's note for the AI
  refs TEXT NOT NULL DEFAULT '[]', -- references sent with it (JSON): the message's chips
  event_id TEXT,               -- a Rufi event's line in the transcript
  position INTEGER NOT NULL,   -- order among the waiting rows
  state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'handing_over', 'sent', 'not_sure', 'removed')),
  held TEXT CHECK (held IN ('paused', 'signed_out', 'restored', 'failed', 'open_failed')), -- a waiting row Rufi doesn't hand over by itself, and why: an event that came while the chat was paused rides with the person's next message; open_failed: the AI's thread didn't open, and the person chooses Try again or New thread
  held_text TEXT,              -- why a hand-over failed, in words for the person
  hold_id TEXT,                -- which open_failed hold this is: Try again and New thread name it, so a stale click changes nothing
  sent_as TEXT,                -- the id the AI got the hand-over under (the rows of one turn share it)
  turn_id TEXT,                -- the turn that used it
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id),
  FOREIGN KEY (person_id, event_id) REFERENCES transcript_entries (person_id, id),
  FOREIGN KEY (person_id, turn_id) REFERENCES turns (person_id, id),
  CHECK ((origin = 'rufi') = (event_id IS NOT NULL)),
  CHECK (held IS NULL OR state = 'waiting'),
  CHECK ((held IS 'open_failed') = (hold_id IS NOT NULL))
) STRICT;

INSERT INTO chat_queue_new (id, person_id, chat_id, origin, text, refs, event_id, position, state, held, held_text, sent_as, turn_id, created_at, updated_at)
  SELECT id, person_id, chat_id, origin, text, refs, event_id, position, state, held, held_text, sent_as, turn_id, created_at, updated_at
  FROM chat_queue ORDER BY rowid;

DROP TABLE chat_queue;
ALTER TABLE chat_queue_new RENAME TO chat_queue;
CREATE INDEX queue_by_chat ON chat_queue (person_id, chat_id, state, position);
