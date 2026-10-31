-- Rufi's waiting messages go to the agent system's queue, which hands them
-- over in order (server/chat.ts), and a chat no longer pauses after a Stop
-- or a restart. A message is sent once Rufi hands it over: there is no
-- "not sure" any more. What an older Rufi left, mapped once:
-- - a chat's pause ends, and a Rufi note held for it waits free;
-- - a hand-over not sure is one Rufi marked (its sent_as, or its own id):
--   at the next start it counts as sent, in its chat with its reply
--   stopped (server/rufi-ai.ts).
-- - files are no longer read before a message goes: Rufi AI has readers
--   read them. A message whose files Rufi was reading, or whose reply ended
--   while they were read (held for that reply's Retry), waits again, with
--   no reply of its own yet; it is in the chat already, so it shows there
--   once.
-- - the older reader goes: its readings that hadn't finished fail, their
--   copies kept, as Rufi's start failed them; nothing reads them by itself.
-- A row held from a restored backup, or for the person's choice, stays
-- held; sent and removed rows stay as they are. Each message keeps how the
-- person sent it while a reply ran: into the reply (steer), or after it
-- (queue); a waiting one is queued. The table is made again, as SQLite does
-- it: new table, copy, drop, rename.
UPDATE chats SET paused = NULL;
UPDATE chat_queue SET held = NULL WHERE state = 'waiting' AND held = 'paused';
UPDATE chat_queue SET held = NULL, held_text = NULL, hold_id = NULL, turn_id = NULL
  WHERE state = 'waiting' AND held = 'reply_ended';
UPDATE chat_queue SET state = 'waiting', turn_id = NULL
  WHERE state = 'handing_over' AND sent_as IS NULL;
UPDATE chat_queue SET state = 'handing_over', sent_as = COALESCE(sent_as, id)
  WHERE state = 'not_sure';
UPDATE document_pages SET entry_attempt = 0
  WHERE entry_attempt > 0
    AND entry_job_id IN (SELECT id FROM jobs WHERE state IN ('queued', 'running'))
    AND entry_attempt = (SELECT attempt FROM jobs WHERE jobs.id = document_pages.entry_job_id);
UPDATE jobs
  SET state = 'failed', error = 'Rufi closed while reading',
    ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), retry_at = NULL
  WHERE state IN ('queued', 'running');

CREATE TABLE chat_queue_new (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('person', 'rufi')),
  kind TEXT NOT NULL DEFAULT 'queue' CHECK (kind IN ('steer', 'queue')),
  text TEXT NOT NULL,
  refs TEXT NOT NULL DEFAULT '[]',
  event_id TEXT,
  position INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'handing_over', 'sent', 'removed')),
  held TEXT CHECK (held IN ('signed_out', 'restored', 'failed', 'stopped', 'open_failed')),
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
  CHECK ((held IS 'open_failed') = (hold_id IS NOT NULL))
) STRICT;

INSERT INTO chat_queue_new (id, person_id, chat_id, origin, text, refs, event_id, position, state, held, held_text, hold_id, sent_as, turn_id, created_at, updated_at)
  SELECT id, person_id, chat_id, origin, text, refs, event_id, position, state, held, held_text, hold_id, sent_as, turn_id, created_at, updated_at
  FROM chat_queue ORDER BY rowid;

DROP TABLE chat_queue;
ALTER TABLE chat_queue_new RENAME TO chat_queue;
CREATE INDEX queue_by_chat ON chat_queue (person_id, chat_id, state, position);
