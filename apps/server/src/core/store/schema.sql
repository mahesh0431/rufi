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
-- together (an add), or a document Rufi AI split from an add (from_document
-- names the add). Its pages point to the files. Rufi AI says what it is
-- when it sorts the add: its kind, its date, and for a report its lab and
-- number. A deleted document stays as a tombstone (docs/adr/0015): its row
-- and its pages' names and positions, for the history and sources that
-- point at them; its files, reader's work, readings and draft items are
-- gone. An upload is unsent while it sits in the chat box: it is out of
-- every list and tool until the person sends it, and taking its chip out
-- removes it.
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  added_at TEXT NOT NULL,
  added_from TEXT NOT NULL CHECK (added_from IN ('documents_page', 'chat')),
  kind TEXT CHECK (kind IN ('lab_report', 'prescription', 'letter', 'other')), -- as Rufi AI sorted it (or an older Rufi read it); null until then
  date TEXT,             -- its date, as Rufi AI sorted it (a report's collection date), at its precision; null until then
  issuer TEXT,           -- a report's lab or clinic, as printed, as Rufi AI sorted it
  report_number TEXT,    -- a report's number, as printed
  reader_note TEXT,      -- an older reader's one note for the whole document
  version INTEGER NOT NULL DEFAULT 0, -- rises whenever its draft items or pages change (a sort, a fix, a reading)
  deleted_at TEXT,       -- when the person deleted it: a tombstone, out of every list and action
  from_document TEXT,    -- the add Rufi AI split it from; null for an add
  sent_at TEXT,          -- when the person sent it in a message; null while it waits unsent in the chat box (a split document has its add's)
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, from_document) REFERENCES documents (person_id, id)
) STRICT;

-- A document's pages in order: a page of a PDF, or a whole photo (page 1).
-- The same content belongs to at most one live document per person. A
-- page's position is its place in the add, and a page keeps it when a split
-- moves it to another document of the add: pages 3 and 4 of an add are
-- pages 3 and 4 of the document split from it.
CREATE TABLE document_pages (
  person_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  position INTEGER NOT NULL,   -- 1, 2, 3... in the document
  file_id TEXT REFERENCES files (id), -- null once its document is deleted
  page_in_file INTEGER NOT NULL, -- 1, 2, 3... in the file
  file_name TEXT NOT NULL,     -- the file's name as it was added
  -- The reader's notebook: this page's entry (JSON, as save_page checked it)
  -- and the job that saved it. A later save_page for the page replaces it.
  -- The reader that copies keeps its copy in page_copies and sets only the
  -- job, attempt and time here, with no entry.
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

-- A document's readings, one row per job, run one at a time across Rufi.
-- A job is made when the reply of the message that sent its document
-- starts, and runs in Rufi's part of that reply: queued or running only
-- while that reply lives, failed when it ends otherwise or at the next
-- start. A reading targets some of its document's pages (all of them
-- first; a read-again only the failed ones), and each run of it is a new
-- attempt: save_page accepts entries only from the running job's current
-- attempt, for its target pages. Only a reader turn that completed
-- normally finishes the job.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('document_read')),
  document_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 0, -- 1, 2, 3... as runs start
  targets TEXT NOT NULL,               -- JSON array of page positions
  retries INTEGER NOT NULL DEFAULT 0,  -- automatic retries used since its start or the person's Retry
  retry_at TEXT,                       -- a queued automatic retry runs from then on
  started_at TEXT,                     -- its first real start
  run_at TEXT,                         -- the current run's start
  ended_at TEXT,
  error TEXT,                          -- why it failed, in words for the person
  usage TEXT,                          -- its runs' AI use as the agent reported it, summed (JSON)
  reader TEXT,                         -- the reader version of its last run (JSON)
  sorted_at TEXT,                      -- when Rufi AI sorted the pages it copied; null until then
  created_at TEXT NOT NULL,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, document_id) REFERENCES documents (person_id, id)
) STRICT;

-- What Rufi AI drafted from a page copy (or an older reader read) and the
-- person hasn't saved yet: one row per item, never part of the record (no
-- answer, Overview or trend counts it). Written by a sort, at version 1,
-- each naming its page and the reading whose copy it cites (job_id). Its
-- fields as Rufi AI gave them are kept as they came (original); a fix
-- changes fields and raises the version.
CREATE TABLE draft_items (
  id TEXT PRIMARY KEY,         -- UUIDv7
  person_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  page INTEGER NOT NULL,       -- the page's position
  seq INTEGER NOT NULL,        -- its order on the page
  job_id TEXT NOT NULL,        -- the reading whose copy of the page it cites (an older Rufi's: the reading that made it)
  kind TEXT NOT NULL CHECK (kind IN ('lab_result')),
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'saved', 'dismissed')),
  fields TEXT NOT NULL,        -- the item's fields now (JSON, as printed)
  original TEXT NOT NULL,      -- Rufi AI's fields (an older Rufi's: the reader's), never changed (JSON)
  unsure TEXT NOT NULL DEFAULT '[]', -- why it is worth a look: Rufi AI's reason (an older Rufi's: the reader's words and Rufi's checks) (JSON)
  quote TEXT,                  -- the text it came from, as in the page copy, for the screen; null for an older Rufi's
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

-- The reader's copy of a page: the page as Markdown, exactly as printed, with the reader's marks
-- for what was unclear. One per page of a file and reading: known by the
-- file page (person, file, page in file) and the reading's job, never by
-- the document the page is in now. A run of the reading saves it again in
-- place until the reading ends; a new reading of the page adds its own.
-- Gone with the page's document.
CREATE TABLE page_copies (
  person_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  page_in_file INTEGER NOT NULL,
  job_id TEXT NOT NULL,        -- the reading that copied it
  attempt INTEGER NOT NULL,    -- the run that saved it, for information only
  outcome TEXT NOT NULL CHECK (outcome IN ('read', 'nothing_here', 'unreadable')),
  copy TEXT NOT NULL,          -- the page as Markdown (HTML tables allowed), as the reader wrote it
  why TEXT,                    -- why it is unreadable
  saved_at TEXT NOT NULL,
  PRIMARY KEY (person_id, file_id, page_in_file, job_id),
  FOREIGN KEY (person_id, file_id, page_in_file) REFERENCES document_pages (person_id, file_id, page_in_file),
  FOREIGN KEY (person_id, job_id) REFERENCES jobs (person_id, id)
) STRICT;

-- A report as printed, made when its results are saved. A draft's report
-- is its document: every save from that document uses one report (an
-- older Rufi's reports may span documents). document_id is its first
-- document; each result's actual page is kept in record_sources.
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

-- A care event that happened (docs/adr/0021), its kind in the person's
-- words; a stay is admitted on date, discharged on ended.
-- It keeps the doctor's words as written, in Markdown with the
-- paper's own headings; for a visit told in the chat, the person's words.
-- The records saved from it cite it in record_sources. A visit to come is
-- a follow-up.
CREATE TABLE visits (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  setting TEXT NOT NULL DEFAULT 'unknown',
  date TEXT,                   -- when it happened; a hospital stay's admission
  date_words TEXT,
  ended TEXT,                  -- a hospital stay's discharge
  ended_words TEXT,
  doctor TEXT,                 -- as written: 'Dr A. Fictional, MBBS'
  place TEXT,                  -- as written: 'Lakeview Family Clinic'
  reason TEXT,                 -- a short line for lists: why they went, or the diagnosis, as written
  as_written TEXT,             -- the doctor's words as written (Markdown)
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id)
) STRICT;

-- A procedure or an immunisation. Planned care is not done care.
CREATE TABLE care_events (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  type TEXT NOT NULL CHECK (type IN ('procedure', 'immunisation')),
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
  paused TEXT CHECK (paused IN ('stopped', 'restarted')), -- no longer used (0020): a chat once paused after a Stop or a restart
  revision INTEGER NOT NULL DEFAULT 0, -- grows with every change to the transcript
  context_tokens INTEGER,      -- the tokens of the thread's last request to the model, as the agent last reported them
  context_window INTEGER,      -- the model's context window then; null: the agent didn't say
  context_thread TEXT,         -- the thread they are of: shown only while it is the chat's thread
  created_at TEXT NOT NULL,
  UNIQUE (person_id, id)
) STRICT;

-- One per reply. Final once it has ended. A reply whose message brings
-- documents to read starts with Rufi's part, before the agent's turn
-- exists: its agent turn and thread are filled when the agent starts, and
-- stay null when it ended in Rufi's part.
CREATE TABLE turns (
  id TEXT PRIMARY KEY,         -- UUIDv7
  person_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  agent_turn_id TEXT,          -- the agent's own id for it
  thread_id TEXT,              -- the agent's thread it ran on: a turn on another thread than the one before started afresh
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
  text TEXT NOT NULL,          -- the message or the reply as it came; an activity's text as the agent reported it (the command, the tool, a note's words); the reasoning's summary; a receipt's, an event's or a brief's line
  activity TEXT CHECK (activity IN ('tool', 'command', 'web_search', 'file_change', 'sub_agent', 'compaction', 'picture', 'note', 'reading', 'other')), -- reading: Rufi's reader copying one document, in Rufi's part of a reply
  detail TEXT,                 -- an activity's second reported part: a tool's arguments, a command's exit code; a picture's path, whole; a reading's progress
  details TEXT,                -- an activity's or reasoning's everything, as the agent gave it (JSON); a reading's job and document; an event's kind and facts (JSON); null: none
  refs TEXT,                   -- a message's references, its chips (JSON); null: none
  status TEXT CHECK (status IN ('running', 'done', 'failed', 'stopped')),
  agent_item_id TEXT,          -- the agent's id for a reply or an activity, to update it
  revision INTEGER NOT NULL,   -- the chat's revision when it last changed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  questions TEXT CHECK (questions IS NULL OR kind = 'reply'), -- a reply's questions, as the AI gave them (JSON), kept apart from its answer; null: none
  UNIQUE (person_id, id),
  UNIQUE (chat_id, seq),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id),
  FOREIGN KEY (person_id, turn_id) REFERENCES turns (person_id, id),
  -- An activity line has its kind and status. A reply has a status from
  -- Codex 0.163 on: running until the agent gave it whole, then done; one
  -- cut when its turn ended (a message sent into it cuts the answer) is stopped. An
  -- older reply has none. Nothing else has either.
  CHECK ((kind = 'activity') = (activity IS NOT NULL)),
  CHECK (kind != 'activity' OR status IS NOT NULL),
  CHECK (status IS NULL OR kind IN ('activity', 'reply')),
  CHECK (details IS NULL OR kind IN ('activity', 'reasoning', 'event')),
  CHECK (refs IS NULL OR kind IN ('message', 'steer'))
) STRICT;

-- Each call the AI made to one of Rufi's own tools, kept by Rufi as it
-- answered: what the AI sent and exactly what it got back.
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
-- row over twice. sent_as is set just before the AI is called: a
-- 'handing_over' row without it surely never reached the AI (Rufi's part of
-- its reply ran, or the thread was opening); one with it becomes 'not_sure'
-- when Rufi stops: shown, never sent again by itself.
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
  held TEXT CHECK (held IN ('paused', 'signed_out', 'restored', 'failed', 'open_failed', 'reply_ended')), -- a waiting row Rufi doesn't hand over by itself, and why (paused no longer: 0020): signed_out: the AI found the sign-in missing, and the row goes once it is back; restored: from a restored backup, for the person to send or remove; failed: the AI couldn't take it, or a Stop cut its start; open_failed: the AI's thread didn't open, and the person chooses Try again or New thread; reply_ended: its reply ended in Rufi's part (a reading stopped or failed), it is in the chat already, and its reply's Retry sends it again
  held_text TEXT,              -- why a hand-over failed, in words for the person
  hold_id TEXT,                -- which open_failed or reply_ended hold this is: the person's choice names it, so a stale click changes nothing
  sent_as TEXT,                -- where Rufi handed it over: the agent and its conversation (<agent>/<number>), set in Rufi's claim before the AI is called; an older hand-over's id
  turn_id TEXT,                -- the turn that used it; set when Rufi's part of its reply starts
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  note TEXT,                   -- Rufi's note on what its part of the reply read, kept once the reading ends; it goes with the message
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id),
  FOREIGN KEY (person_id, event_id) REFERENCES transcript_entries (person_id, id),
  FOREIGN KEY (person_id, turn_id) REFERENCES turns (person_id, id),
  CHECK ((origin = 'rufi') = (event_id IS NOT NULL)),
  CHECK (held IS NULL OR state = 'waiting'),
  CHECK ((held IS 'open_failed' OR held IS 'reply_ended') = (hold_id IS NOT NULL))
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
-- message, a page of a document, or a Visit (the records saved from a
-- visit cite it; the Visit cites its paper's page). Each is added by a save, and a later
-- save may take it off (removed_by); it is never deleted. Saying "save it"
-- isn't a source: it only says yes.
CREATE TABLE record_sources (
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- the record's kind: 'result', 'symptom'...
  record_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('message', 'document_page', 'visit')),
  entry_id TEXT,               -- message: the user's message
  document_id TEXT,            -- document_page: the document and its page
  page INTEGER,
  visit_id TEXT,               -- visit: the Visit
  operation_id TEXT,           -- the save that added it; null for one from before Rufi kept saves
  removed_by TEXT,             -- the save that took it off
  FOREIGN KEY (person_id, entry_id) REFERENCES transcript_entries (person_id, id),
  FOREIGN KEY (person_id, document_id, page) REFERENCES document_pages (person_id, document_id, position),
  FOREIGN KEY (person_id, visit_id) REFERENCES visits (person_id, id),
  FOREIGN KEY (person_id, operation_id) REFERENCES operations (person_id, id),
  FOREIGN KEY (person_id, removed_by) REFERENCES operations (person_id, id),
  CHECK ((type = 'message') = (entry_id IS NOT NULL)),
  CHECK ((type = 'document_page') = (document_id IS NOT NULL AND page IS NOT NULL)),
  CHECK ((type = 'visit') = (visit_id IS NOT NULL))
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

-- Device data (docs/adr/0023): what a person's devices and apps measured,
-- kept outside the record, with no chat and no save. A device source is a
-- connection ("Apple Health on Asha's iPhone"), bound to one person for good:
-- a batch's person comes only from its source, never from what it says.
CREATE TABLE device_sources (
  id TEXT PRIMARY KEY,         -- UUIDv7
  person_id TEXT NOT NULL REFERENCES people (id),
  system TEXT NOT NULL CHECK (system IN ('apple_health')), -- the space its values' IDs live in
  name TEXT NOT NULL,          -- as given
  created_at TEXT NOT NULL,
  last_batch_at TEXT,          -- the last batch received: kept here, since batches go
  UNIQUE (person_id, id),
  UNIQUE (person_id, id, system)
) STRICT;

-- One page a source sent, its bytes exactly as they came (gzip), and its
-- conversion's state: waiting, done, or failed with a reason and the time
-- of its next try. seq is the order of arrival across all sources; within
-- one person and system (a group), only the lowest batch not done may be
-- converted, so a deletion never comes before the value it deletes. A done
-- batch goes 30 days after it was converted, unless items were skipped
-- (skipped is null when none were): then it holds the only copy of data
-- Rufi got but couldn't read, and stays.
CREATE TABLE device_batches (
  id TEXT PRIMARY KEY,         -- UUIDv7
  person_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  seq INTEGER NOT NULL UNIQUE, -- 1, 2, 3...: set by receive in its transaction
  sender_batch_id TEXT NOT NULL, -- the sender's ID for the page: the same page again is the same batch
  received_at TEXT NOT NULL,
  body BLOB NOT NULL,          -- the page's bytes exactly, gzip
  body_sha256 TEXT NOT NULL,   -- of the bytes before gzip
  body_bytes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'done', 'failed')),
  tries INTEGER NOT NULL DEFAULT 0, -- failed tries
  retry_at TEXT,               -- a failed batch's next try
  reason TEXT,                 -- why the last try failed: a fixed code, never health text
  done_at TEXT,
  counts TEXT,                 -- JSON: what came of it (added, changed, already_had...)
  skipped TEXT,                -- JSON: [{id, reason}] of the items not converted; null when none
  UNIQUE (person_id, id),
  UNIQUE (source_id, sender_batch_id),
  FOREIGN KEY (person_id, source_id) REFERENCES device_sources (person_id, id),
  CHECK ((status = 'done') = (done_at IS NOT NULL))
) STRICT;

-- One thing a device measured, in Rufi's terms: a type key from Rufi's type
-- list (core/devices/types.ts), the number in that type's unit, the
-- instants in UTC, and where it was taken (utc_offset, time_zone) only when
-- the source knew it. Keyed by the source system's own ID, so the same
-- value sent again, or by a second phone on the same Apple Health, is kept
-- once. A series holds the single values a condensed sample stands for;
-- value is then the source's average. batch_id is the batch that last
-- wrote it, emptied when that batch goes. A value the source deleted is
-- marked removed_at.
CREATE TABLE device_values (
  person_id TEXT NOT NULL,
  system TEXT NOT NULL,
  external_id TEXT NOT NULL,   -- the source system's ID, such as Apple's UUID
  source_id TEXT NOT NULL,     -- the source that first sent it
  type TEXT NOT NULL,          -- a key of the type list, never removed or renamed
  value REAL NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  utc_offset INTEGER,          -- minutes east of UTC at the start, when the source knew it
  time_zone TEXT,              -- an IANA name, when the source gave one
  device TEXT,                 -- what measured it, as the source named it
  context TEXT,                -- JSON: the metadata the type keeps, as sent
  series TEXT,                 -- JSON: [{start_at, end_at, value}], or null
  batch_id TEXT,
  removed_at TEXT,
  PRIMARY KEY (person_id, system, external_id),
  FOREIGN KEY (person_id, source_id, system) REFERENCES device_sources (person_id, id, system),
  FOREIGN KEY (person_id, batch_id) REFERENCES device_batches (person_id, id)
) STRICT, WITHOUT ROWID;

CREATE INDEX documents_by_added ON documents (person_id, added_at);
CREATE INDEX documents_by_add ON documents (person_id, from_document);
CREATE INDEX jobs_by_state ON jobs (state, created_at);
CREATE INDEX jobs_by_document ON jobs (person_id, document_id, created_at);
CREATE INDEX page_copies_by_job ON page_copies (person_id, job_id);
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
CREATE INDEX sources_by_visit ON record_sources (person_id, visit_id);
CREATE INDEX drafts_by_document ON draft_items (person_id, document_id, page, seq);
CREATE INDEX device_batches_by_status ON device_batches (status, seq);
CREATE INDEX device_batches_by_done ON device_batches (done_at);
CREATE INDEX device_values_by_type ON device_values (person_id, type, start_at);
CREATE INDEX device_values_by_batch ON device_values (person_id, batch_id) WHERE batch_id IS NOT NULL;

-- Which person and chat each agent of the agent system belongs to
-- (packages/agents, its own agents.sqlite, docs/adr/0024): the agent system
-- knows no people, so Rufi keeps this before an agent may run. An agent
-- with no owner never runs. root: the chat's own agent, Rufi AI.
CREATE TABLE agent_owners (
  agent_id TEXT PRIMARY KEY,   -- the agent's id in agents.sqlite
  person_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  root INTEGER NOT NULL CHECK (root IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (person_id, agent_id),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id)
) STRICT;

CREATE UNIQUE INDEX agent_owners_root ON agent_owners (chat_id) WHERE root = 1;

-- Every provider conversation a chat's agents had (the ledger), saved before
-- any of Rufi's content goes into it, and kept when a new conversation
-- replaces it, when its agent is gone, and when agents.sqlite is lost: a
-- hand-over is asked about by it, and forgetting the chat deletes each.
CREATE TABLE agent_conversations (
  person_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,      -- the agent's id, as it was: the agent may be gone
  conversation INTEGER NOT NULL, -- the agent's number for it: 1, 2, 3...
  provider TEXT NOT NULL,      -- the adapter it runs on (codex)
  ref TEXT NOT NULL,           -- the provider's reference for it (a Codex thread)
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, conversation),
  UNIQUE (provider, ref),
  FOREIGN KEY (person_id, chat_id) REFERENCES chats (person_id, id)
) STRICT;

-- How far Rufi has applied the agent system's event log: the agents.sqlite
-- it read (its generation) and the last event applied, moved in the same
-- transaction as that event's change. Another generation is a new file.
CREATE TABLE agent_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation TEXT NOT NULL,
  number INTEGER NOT NULL
) STRICT;

-- The version this file makes: the number of migrations (./migrations.ts).
PRAGMA user_version = 20;
