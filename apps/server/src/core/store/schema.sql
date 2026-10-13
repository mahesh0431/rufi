-- Rufi's one database. Connections must run `PRAGMA foreign_keys = ON`.
--
-- Person scope is a relation, not just a column: every person-owned row carries
-- person_id, and references between person-owned rows go through composite
-- foreign keys (person_id, id), so a row for one person can never point at
-- another person's row. File bytes are shared and carry no person.
--
-- Dates are text at the precision they were known: 'YYYY', 'YYYY-MM' or
-- 'YYYY-MM-DD' (times as ISO 8601). Values are stored as printed.
--
-- The record changes only through a save (docs/adr/0005): one transaction
-- that writes the records, each record's before and after (record_changes)
-- and the save's receipt in the transcript. A record is never deleted:
-- removing it sets removed, and its history stays. A record's sources
-- (record_sources) are what its values rest on: the user's messages and
-- document pages. A date said in words keeps those words beside it
-- (*_words), counted from that message's time.

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL
) STRICT;

-- Original bytes, exactly as they came, shared across people. The bytes are
-- in files/<id> in the data folder, written and synced before any row points
-- to them; a row is only added with a document page that uses it, and goes
-- (with its bytes) once no live page of anyone uses it.
CREATE TABLE files (
  id TEXT PRIMARY KEY,   -- sha256 of the bytes, hex
  size INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif')),
  created_at TEXT NOT NULL
) STRICT;

-- What the user added for a person: one PDF, or one or more photos added
-- together. Its pages point to the files. A deleted document stays as a
-- tombstone (docs/adr/0015): its row and its pages' names and positions, for
-- the history and sources that point at them; its files, reader's work,
-- readings and draft items are gone.
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  added_at TEXT NOT NULL,
  added_from TEXT NOT NULL CHECK (added_from IN ('documents_page', 'chat')),
  kind TEXT CHECK (kind IN ('lab_report', 'prescription', 'letter', 'other')), -- as read; null until read
  date TEXT,             -- the document's date as read (precision date), when every page agrees; null until read
  reader_note TEXT,      -- the reader's one note for the whole document, rewritten by the reader
  version INTEGER NOT NULL DEFAULT 0, -- rises whenever its draft items change (a reading, a retry)
  deleted_at TEXT,       -- when the person deleted it: a tombstone, out of every list and action
  UNIQUE (person_id, id)
) STRICT;

-- A document's pages in order: a page of a PDF, or a whole photo (page 1).
-- The same content belongs to at most one live document per person.
CREATE TABLE document_pages (
  person_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  position INTEGER NOT NULL,   -- 1, 2, 3... in the document
  file_id TEXT REFERENCES files (id), -- null once its document is deleted
  page_in_file INTEGER NOT NULL, -- 1, 2, 3... in the file
  file_name TEXT NOT NULL,     -- the file's name as it was added
  -- The reader's notebook: this page's entry (JSON, as save_page checked it)
  -- and the job that saved it. A later save_page for the page replaces it.
  entry TEXT,
  entry_job_id TEXT,
  entry_attempt INTEGER,      -- run that saved it; 0 if that run failed
  entry_at TEXT,
  entry_checks TEXT,           -- Rufi's checks of the entry (JSON): they flag, never change it
  -- What the page is once a reading that targeted it finished: its entry's
  -- outcome, or not_looked_at when it had none; null while it waits.
  state TEXT CHECK (state IN ('read', 'nothing_here', 'unreadable', 'not_looked_at')),
  state_why TEXT,              -- why it is unreadable
  PRIMARY KEY (person_id, document_id, position),
  UNIQUE (person_id, file_id, page_in_file),
  FOREIGN KEY (person_id, document_id) REFERENCES documents (person_id, id),
  FOREIGN KEY (person_id, entry_job_id) REFERENCES jobs (person_id, id)
) STRICT;

-- Background work for a person, one row per job, run one at a time. A
-- reading targets some of its document's pages (all of them first; a retry
-- only the failed ones), and each run of it is a new attempt: save_page
-- accepts entries only from the running job's current attempt, for its
-- target pages. A run Rufi stopped for a restart is queued again; only a
-- reader turn that completed normally finishes the job.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('document_read')),
  document_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 0, -- 1, 2, 3... as runs start
  targets TEXT NOT NULL,               -- JSON array of page positions
  waiting TEXT CHECK (waiting IN ('sign_in', 'usage_limit')), -- a queued job that waits for this before it runs
  wait_until TEXT,                     -- a usage limit's reset time
  retried INTEGER NOT NULL DEFAULT 0,  -- 1 once its one automatic retry is used
  started_at TEXT,                     -- its first real start: the chat's start line
  run_at TEXT,                         -- the current run's start
  ended_at TEXT,
  error TEXT,                          -- why it failed, in words for the person
  usage TEXT,                          -- its runs' AI use as the agent reported it, summed (JSON)
  reader TEXT,                         -- the reader version of its last run (JSON)
  created_at TEXT NOT NULL,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, document_id) REFERENCES documents (person_id, id)
) STRICT;

-- What a reading found and the person hasn't saved yet: one row per item,
-- never part of the record (no answer, Overview or trend counts it). Made
-- from a job's notebook entries when the job finishes, at version 1. The
-- reader's fields are kept as they came (original); a fix changes fields
-- and raises the version.
CREATE TABLE draft_items (
  id TEXT PRIMARY KEY,         -- UUIDv7
  person_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  page INTEGER NOT NULL,       -- the page's position in the document
  seq INTEGER NOT NULL,        -- its order on the page
  job_id TEXT NOT NULL,        -- the reading that made it
  kind TEXT NOT NULL CHECK (kind IN ('lab_result')),
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'saved', 'dismissed')),
  fields TEXT NOT NULL,        -- the item's fields now (JSON, as printed)
  original TEXT NOT NULL,      -- the reader's fields, never changed (JSON)
  unsure TEXT NOT NULL DEFAULT '[]', -- why it may be wrong: the reader's words and Rufi's checks (JSON)
  -- Once saved: how, into which record, by which save; the version saved is
  -- its version (saving doesn't raise it). Once dismissed: by which call.
  saved_as TEXT CHECK (saved_as IN ('new', 'another_source', 'correction')),
  record_kind TEXT,
  record_id TEXT,
  operation_id TEXT,
  dismissed_by TEXT,           -- the AI's call that dismissed it
  created_at TEXT NOT NULL,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, document_id, page) REFERENCES document_pages (person_id, document_id, position),
  FOREIGN KEY (person_id, job_id) REFERENCES jobs (person_id, id),
  FOREIGN KEY (person_id, operation_id) REFERENCES operations (person_id, id),
  CHECK ((status = 'saved') = (operation_id IS NOT NULL)),
  CHECK ((status = 'dismissed') = (dismissed_by IS NOT NULL))
) STRICT;

-- A report as printed, made when its results are saved. A complete lab,
-- report number and collection date identifies it across the person's
-- documents; otherwise it stays within one document. document_id is its
-- first document; each result's actual page is kept in record_sources.
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  issuer TEXT,           -- lab or clinic, as printed
  report_number TEXT,    -- as printed
  collected TEXT,        -- precision date
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, document_id) REFERENCES documents (person_id, id)
) STRICT;

CREATE TABLE results (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  report_id TEXT,        -- null when typed in rather than read from a report
  category TEXT NOT NULL CHECK (category IN ('lab', 'measurement')), -- the AI's choice with the person; the pages filter by it
  test_name TEXT NOT NULL,     -- as printed
  value_text TEXT NOT NULL,    -- as printed, e.g. '<5', '6.8', 'Negative'
  comparator TEXT,             -- '<', '<=', '>' or '>=' when printed; '<5' is not 5
  value_number REAL,           -- the plain number, when there is one
  unit TEXT,                   -- as printed
  reference_range TEXT,        -- as printed
  flag_text TEXT,              -- 'High' / 'Low' only as printed; Rufi adds none
  context_text TEXT,           -- method or context as printed, e.g. 'Calculated', 'Fasting'
  measured_at TEXT,            -- when the sample was taken, or the measurement made (precision date or time)
  entered_at TEXT NOT NULL,    -- when it entered Rufi
  replaces_id TEXT,            -- an amended result points at the one it replaces
  group_label TEXT,            -- a shared label to join two printed names; printed fields never change
  second_number REAL,          -- a two-value result's second number: a blood pressure '128/84' is 128 and 84
  measured_words TEXT,         -- the words for measured_at: the user's, or the date as printed with its label
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, report_id) REFERENCES reports (person_id, id),
  FOREIGN KEY (person_id, replaces_id) REFERENCES results (person_id, id)
) STRICT;

-- One use of a medicine or supplement. Several uses of one medicine can
-- coexist (a morning and a night dose); each stops on its own.
CREATE TABLE medicine_uses (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  name TEXT NOT NULL,
  strength TEXT,               -- '500 mg'
  amount TEXT,                 -- how much is taken: '1 tablet'
  schedule TEXT,               -- 'twice a day', 'at night'
  route TEXT,
  purpose TEXT,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('current', 'paused', 'stopped', 'completed', 'unknown')),
  started TEXT,
  started_words TEXT,
  ended TEXT,
  ended_words TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id)
) STRICT;

-- What a prescriber wrote for one item. It never makes a medicine use.
CREATE TABLE prescriptions (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  item TEXT NOT NULL,
  strength TEXT,
  amount TEXT,
  route TEXT,
  schedule TEXT,
  period TEXT,                 -- the intended period, as written: 'for 5 days'
  prescriber TEXT,
  issued TEXT,
  issued_words TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id)
) STRICT;

-- One episode of a symptom; a symptom that comes back is a new episode.
CREATE TABLE symptoms (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('ongoing', 'resolved', 'unknown')),
  onset TEXT,
  onset_words TEXT,
  ended TEXT,
  ended_words TEXT,
  severity TEXT,
  location TEXT,
  intermittent INTEGER,        -- 1 comes and goes, 0 constant; null unknown
  details TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id)
) STRICT;

CREATE TABLE conditions (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  name TEXT NOT NULL,
  certainty TEXT NOT NULL DEFAULT 'unknown' CHECK (certainty IN ('suspected', 'diagnosed', 'unknown')),
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('ongoing', 'resolved', 'unknown')),
  recognised TEXT,
  recognised_words TEXT,
  resolved TEXT,
  resolved_words TEXT,
  details TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id)
) STRICT;

-- An allergy or intolerance. Only a change to its status makes it inactive;
-- a reaction that ended doesn't.
CREATE TABLE allergies (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  substance TEXT NOT NULL,
  reaction TEXT,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('active', 'inactive', 'unknown')),
  certainty TEXT NOT NULL DEFAULT 'unknown' CHECK (certainty IN ('confirmed', 'suspected', 'unknown')),
  asserted TEXT,               -- the day the user said it: their message's date
  reacted TEXT,                -- when the reaction happened
  reacted_words TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id)
) STRICT;

-- A visit, procedure or immunisation. Planned care is not done care.
CREATE TABLE care_events (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  type TEXT NOT NULL CHECK (type IN ('visit', 'procedure', 'immunisation')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('planned', 'done', 'not_done', 'unknown')),
  date TEXT,
  date_words TEXT,
  provider TEXT,
  details TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id)
) STRICT;

-- "None known", as the user said it on a day: a dated statement, never
-- current while an active allergy is.
CREATE TABLE none_known (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  category TEXT NOT NULL CHECK (category IN ('allergies')),
  asserted TEXT,               -- the day the user said it: their message's date
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id)
) STRICT;

-- Something to come back to (PLAN.md §2.2).
CREATE TABLE follow_ups (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  title TEXT NOT NULL,
  due TEXT,                    -- a date at its precision, 'next_visit', or null: none
  due_words TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
  outcome TEXT,
  linked_kind TEXT,            -- the record it is about, when there is one
  linked_id TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id)
) STRICT;

-- The notices Rufi gave for follow-ups (docs/adr/0012): for each one, the
-- due it was for and the last state told (due, then overdue). Operational
-- state, not the record: no save writes it and no history keeps it. Only
-- the notice claim (core/record/notices.ts) writes it.
CREATE TABLE follow_up_notices (
  person_id TEXT NOT NULL,
  follow_up_id TEXT NOT NULL,
  due TEXT NOT NULL,           -- the follow-up's due when the notice was given
  state TEXT NOT NULL CHECK (state IN ('due', 'overdue')),
  PRIMARY KEY (person_id, follow_up_id),
  FOREIGN KEY (person_id, follow_up_id) REFERENCES follow_ups (person_id, id)
) STRICT;

-- Rufi-wide settings, such as the emergency region. One row per key.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- Each person's one chat with Rufi's AI, made in the same transaction as the
-- person (transcripts.addFirstPerson). Chats and their transcripts are
-- Rufi's own (docs/adr/0004). The agent's thread is only a pointer: a new
-- one can start at any time.
CREATE TABLE chats (
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
  created_at TEXT NOT NULL,
  UNIQUE (person_id, id)
) STRICT;

-- One per reply the agent ran. Final once it has ended.
CREATE TABLE turns (
  id TEXT PRIMARY KEY,         -- UUIDv7
  person_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  agent_turn_id TEXT NOT NULL, -- the agent's own id for it
  thread_id TEXT NOT NULL,     -- the agent's thread it ran on: a turn on another thread than the one before started afresh
  model TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'person' CHECK (origin IN ('person', 'rufi')), -- who started it: a Rufi event's turn can only read
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'interrupted', 'failed')),
  end_reason TEXT CHECK (end_reason IN ('stopped', 'timeout', 'usage_limit', 'rate_limit', 'sign_in', 'connection', 'provider_failed', 'save_failed')),
  end_text TEXT,               -- why it didn't complete, for the screen
  resets_at TEXT,              -- a usage limit's reset time, when the provider gave one
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (person_id, id),
  UNIQUE (chat_id, agent_turn_id),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id)
) STRICT;

-- A chat's transcript, in order: your messages (steers marked), one
-- line per thing the agent did with everything it sent and got back, the
-- agent's reasoning and its replies, Rufi's receipts, Rufi's events
-- (its own factual lines, never the person's words) and the line of each
-- visit brief. Stored before anyone is shown it.
CREATE TABLE transcript_entries (
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

-- Each call the AI made to one of Rufi's own tools, kept by Rufi as it
-- answered: what the AI sent and exactly what it got back. A reply's Used
-- (what it read) is built from these and its activity lines.
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,         -- UUIDv7
  person_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,       -- the reply it belongs to
  call_id TEXT NOT NULL,       -- the agent's id for the call: its activity line's agent_item_id
  tool TEXT NOT NULL,          -- 'get_overview', 'get_records'...
  input TEXT NOT NULL,         -- what the AI sent (JSON)
  answer TEXT NOT NULL,        -- exactly what the AI got back (JSON)
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id),
  FOREIGN KEY (person_id, turn_id) REFERENCES turns (person_id, id)
) STRICT;

-- One unsent message per chat; the last save wins. Rufi never sends a draft
-- by itself: a send moves the text into the queue and empties the draft in
-- one transaction.
CREATE TABLE drafts (
  person_id TEXT NOT NULL REFERENCES people (id),
  chat_id TEXT NOT NULL,
  text TEXT NOT NULL,          -- may be empty
  refs TEXT NOT NULL DEFAULT '[]', -- the box's references (JSON): its chips
  updated_at TEXT NOT NULL,
  PRIMARY KEY (person_id, chat_id),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id)
) STRICT;

-- What waits to go to the AI, Rufi's own (docs/adr/0004): the person's
-- messages and Rufi's events that ask the AI. Rufi hands the AI one turn's
-- rows at a time, claimed here before it calls the AI, and never hands a
-- row over twice. 'handing_over' when Rufi stops becomes 'not_sure': shown,
-- never sent again by itself.
CREATE TABLE chat_queue (
  id TEXT PRIMARY KEY,         -- UUIDv7, given by the send: the acceptance identity; a person's message keeps it in the transcript
  person_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('person', 'rufi')),
  text TEXT NOT NULL,          -- the person's message, or Rufi's note for the AI
  refs TEXT NOT NULL DEFAULT '[]', -- references sent with it (JSON): the message's chips
  event_id TEXT,               -- a Rufi event's line in the transcript
  position INTEGER NOT NULL,   -- order among the waiting rows
  state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'handing_over', 'sent', 'not_sure', 'removed')),
  held TEXT CHECK (held IN ('paused', 'signed_out', 'restored', 'failed')), -- a waiting row Rufi doesn't hand over by itself, and why: an event that came while the chat was paused rides with the person's next message
  held_text TEXT,              -- why a hand-over failed, in words for the person
  sent_as TEXT,                -- the id the AI got the hand-over under (the rows of one turn share it)
  turn_id TEXT,                -- the turn that used it
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id),
  FOREIGN KEY (person_id, event_id) REFERENCES transcript_entries (person_id, id),
  FOREIGN KEY (person_id, turn_id) REFERENCES turns (person_id, id),
  CHECK ((origin = 'rufi') = (event_id IS NOT NULL)),
  CHECK (held IS NULL OR state = 'waiting')
) STRICT;

-- One save to the record, made by the AI's call to save_changes in a
-- chat. Its receipt is the transcript entry with the same id. seq is the
-- order of saves, across people: history is read in that order, never by
-- time (the Mac's clock can move back) or rowid (VACUUM may renumber it).
CREATE TABLE operations (
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

-- Each record a save changed: the whole row before and after (JSON), so it
-- can be seen and changed back.
CREATE TABLE record_changes (
  operation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,        -- 1, 2, 3... in the save
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- the record's kind: 'medicine_use', 'symptom'...
  record_id TEXT NOT NULL,
  -- link and unlink add or take off one of its sources; its values stay.
  action TEXT NOT NULL CHECK (action IN ('add', 'change', 'remove', 'restore', 'link', 'unlink')),
  before TEXT,                 -- null when added
  after TEXT NOT NULL,
  source_entry_id TEXT,        -- the user's message the change rests on; null for a save from a document alone
  PRIMARY KEY (operation_id, seq),
  FOREIGN KEY (person_id, operation_id) REFERENCES operations (person_id, id),
  FOREIGN KEY (person_id, source_entry_id) REFERENCES transcript_entries (person_id, id)
) STRICT;

-- Where a record's values came from, several per record: the user's
-- message, or a page of a document. Each is added by a save, and a later
-- save may take it off (removed_by); it is never deleted. Saying "save it"
-- isn't a source: it only says yes.
CREATE TABLE record_sources (
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- the record's kind: 'result', 'symptom'...
  record_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('message', 'document_page')),
  entry_id TEXT,               -- message: the user's message
  document_id TEXT,            -- document_page: the document and its page
  page INTEGER,
  operation_id TEXT,           -- the save that added it; null for one from before Rufi kept saves
  removed_by TEXT,             -- the save that took it off
  FOREIGN KEY (person_id, entry_id) REFERENCES transcript_entries (person_id, id),
  FOREIGN KEY (person_id, document_id, page) REFERENCES document_pages (person_id, document_id, position),
  FOREIGN KEY (person_id, operation_id) REFERENCES operations (person_id, id),
  FOREIGN KEY (person_id, removed_by) REFERENCES operations (person_id, id),
  CHECK ((type = 'message') = (entry_id IS NOT NULL)),
  CHECK ((type = 'document_page') = (document_id IS NOT NULL AND page IS NOT NULL))
) STRICT;

-- A visit brief the AI wrote from the saved record, in a chat. Its line in
-- the transcript has the same id. It never changes: it keeps the record
-- version it was made from (the person's count of saves when the AI started
-- reading), so a later save shows as "the record changed since", and each
-- record it cites with that record's version then (the save that last
-- changed it), so its Sources show what it rested on.
CREATE TABLE briefs (
  id TEXT PRIMARY KEY,         -- UUIDv7
  person_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  turn_id TEXT,                -- the reply that made it
  call_id TEXT NOT NULL,       -- the agent's id for the call: the same call again is the same brief
  markdown TEXT NOT NULL,      -- as the AI wrote it
  record_version INTEGER NOT NULL,
  cited TEXT NOT NULL,         -- JSON: [{kind, id, version}], version null for a record no save has changed
  created_at TEXT NOT NULL,
  UNIQUE (person_id, id),
  UNIQUE (chat_id, call_id),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id),
  FOREIGN KEY (person_id, turn_id) REFERENCES turns (person_id, id),
  FOREIGN KEY (person_id, id) REFERENCES transcript_entries (person_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX documents_by_added ON documents (person_id, added_at);
CREATE INDEX jobs_by_state ON jobs (state, created_at);
CREATE INDEX jobs_by_document ON jobs (person_id, document_id, created_at);
CREATE INDEX reports_by_document ON reports (person_id, document_id);
CREATE INDEX results_by_report ON results (person_id, report_id);
CREATE INDEX results_by_test ON results (person_id, test_name, unit, measured_at);
CREATE INDEX results_by_replaced ON results (person_id, replaces_id); -- current results leave out replaced ones
CREATE INDEX turns_by_chat ON turns (person_id, chat_id, started_at);
CREATE INDEX turns_by_status ON turns (status); -- running turns, found at start
CREATE INDEX entries_by_turn ON transcript_entries (person_id, turn_id);
CREATE INDEX queue_by_chat ON chat_queue (person_id, chat_id, state, position);
CREATE INDEX tool_calls_by_turn ON tool_calls (person_id, turn_id);
CREATE INDEX operations_by_person ON operations (person_id, seq);
CREATE INDEX changes_by_record ON record_changes (person_id, record_id);
CREATE INDEX sources_by_record ON record_sources (person_id, record_id);
CREATE INDEX drafts_by_document ON draft_items (person_id, document_id, page, seq);

-- The version this file makes: the number of migrations (./migrations.ts).
PRAGMA user_version = 6;
