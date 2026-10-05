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
-- removing it sets removed, and its history stays. A record's source is the
-- user's message its current values rest on; a date said in words keeps
-- those words beside it (*_words), counted from that message's time.

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL
) STRICT;

-- Deduplicated original bytes, shared across people.
CREATE TABLE files (
  id TEXT PRIMARY KEY,   -- sha256 of the bytes, hex
  size INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  file_id TEXT NOT NULL REFERENCES files (id),
  original_name TEXT NOT NULL,
  added_at TEXT NOT NULL,
  UNIQUE (person_id, id),
  UNIQUE (person_id, file_id) -- the same bytes for the same person reuse the document
) STRICT;

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  issuer TEXT,           -- lab or clinic, as printed
  collected TEXT,        -- precision date
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, document_id) REFERENCES documents (person_id, id)
) STRICT;

CREATE TABLE results (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  report_id TEXT,        -- null when typed in rather than read from a report
  test_name TEXT NOT NULL,     -- as printed
  value_text TEXT NOT NULL,    -- as printed, e.g. '<5', '6.8', 'Negative'
  comparator TEXT,             -- '<', '<=', '>' or '>=' when printed; '<5' is not 5
  value_number REAL,           -- the plain number, when there is one
  unit TEXT,                   -- as printed
  reference_range TEXT,        -- as printed
  flag_text TEXT,              -- 'High' / 'Low' only as printed; Rufi adds none
  context_text TEXT,           -- method or context as printed, e.g. 'Calculated', 'Fasting'
  measured_at TEXT,            -- when the sample was taken (precision date or time)
  entered_at TEXT NOT NULL,    -- when it entered Rufi
  replaces_id TEXT,            -- an amended result points at the one it replaces
  group_label TEXT,            -- a shared label to join two printed names; printed fields never change
  second_number REAL,          -- a two-value result's second number: a blood pressure '128/84' is 128 and 84
  measured_words TEXT,         -- the user's words for measured_at, when typed in
  source_entry_id TEXT,        -- typed in: the user's message it rests on
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, report_id) REFERENCES reports (person_id, id),
  FOREIGN KEY (person_id, replaces_id) REFERENCES results (person_id, id),
  FOREIGN KEY (person_id, source_entry_id) REFERENCES transcript_entries (person_id, id)
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
  source_entry_id TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, source_entry_id) REFERENCES transcript_entries (person_id, id)
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
  source_entry_id TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, source_entry_id) REFERENCES transcript_entries (person_id, id)
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
  source_entry_id TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, source_entry_id) REFERENCES transcript_entries (person_id, id)
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
  source_entry_id TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, source_entry_id) REFERENCES transcript_entries (person_id, id)
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
  source_entry_id TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, source_entry_id) REFERENCES transcript_entries (person_id, id)
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
  source_entry_id TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, source_entry_id) REFERENCES transcript_entries (person_id, id)
) STRICT;

-- "None known", as the user said it on a day: a dated statement, never
-- current while an active allergy is.
CREATE TABLE none_known (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  category TEXT NOT NULL CHECK (category IN ('allergies')),
  asserted TEXT,               -- the day the user said it: their message's date
  source_entry_id TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, source_entry_id) REFERENCES transcript_entries (person_id, id)
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
  source_entry_id TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, source_entry_id) REFERENCES transcript_entries (person_id, id)
) STRICT;

-- Rufi-wide settings, such as the emergency region. One row per key.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- Conversations and their transcripts are Rufi's own (docs/adr/0004). The
-- agent's thread is only a pointer: a new one can start at any time.
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,         -- UUIDv7
  person_id TEXT NOT NULL REFERENCES people (id),
  title TEXT,                  -- the first words of the first message Rufi took; null until then
  provider TEXT NOT NULL,      -- the agent chosen for it: 'codex'
  model TEXT,                  -- the model chosen for it; null: the first allowed one, set when the first message goes
  thread_id TEXT,              -- the agent's thread; none until the first message
  thread_provider TEXT,        -- whose thread it is, so another agent never reuses it
  thread_model TEXT,           -- the model the thread started with
  thread_tools TEXT,           -- the tool set it started with (a thread keeps its tools)
  revision INTEGER NOT NULL DEFAULT 0, -- grows with every change to the transcript
  created_at TEXT NOT NULL,
  UNIQUE (person_id, id)
) STRICT;

-- One per reply the agent ran. Final once it has ended.
CREATE TABLE turns (
  id TEXT PRIMARY KEY,         -- UUIDv7
  person_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  agent_turn_id TEXT NOT NULL, -- the agent's own id for it
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'interrupted', 'failed')),
  end_reason TEXT CHECK (end_reason IN ('stopped', 'timeout', 'usage_limit', 'rate_limit', 'sign_in', 'connection', 'provider_failed', 'save_failed')),
  end_text TEXT,               -- why it didn't complete, for the screen
  resets_at TEXT,              -- a usage limit's reset time, when the provider gave one
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (person_id, id),
  UNIQUE (conversation_id, agent_turn_id),
  FOREIGN KEY (person_id, conversation_id) REFERENCES conversations (person_id, id)
) STRICT;

-- A conversation's transcript, in order: your messages (steers marked), one
-- line per thing the agent did, and its replies. Stored before anyone is
-- shown it. Never tool outputs or reasoning.
CREATE TABLE transcript_entries (
  id TEXT PRIMARY KEY,         -- UUIDv7; a message keeps the id the agent got with it
  person_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,        -- 1, 2, 3... in the conversation
  turn_id TEXT,                -- the reply it belongs to
  kind TEXT NOT NULL CHECK (kind IN ('message', 'steer', 'activity', 'reply', 'receipt')),
  text TEXT NOT NULL,          -- the message or the reply; an activity's short title; a receipt's line
  activity TEXT CHECK (activity IN ('tool', 'command', 'web_search', 'file_change', 'sub_agent', 'other')),
  detail TEXT,                 -- an activity's one short detail: the query, the search words, the command
  status TEXT CHECK (status IN ('running', 'done', 'failed', 'stopped')),
  agent_item_id TEXT,          -- the agent's id for a reply or an activity, to update it
  revision INTEGER NOT NULL,   -- the conversation's revision when it last changed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (person_id, id),
  UNIQUE (conversation_id, seq),
  FOREIGN KEY (person_id, conversation_id) REFERENCES conversations (person_id, id),
  FOREIGN KEY (person_id, turn_id) REFERENCES turns (person_id, id),
  -- An activity line has its kind and status; nothing else has either.
  CHECK ((kind = 'activity') = (activity IS NOT NULL) AND (kind = 'activity') = (status IS NOT NULL))
) STRICT;

-- One unsent message per conversation. Rufi never sends a draft by itself.
-- A send holds the draft (state 'sending', its message id in attempt) until
-- the agent took the message (the draft is emptied) or refused it (the
-- text is back); nobody can change it meanwhile. 'unknown': Rufi stopped
-- during that send, so the text stays, and nobody knows if the agent has it.
CREATE TABLE drafts (
  person_id TEXT NOT NULL REFERENCES people (id),
  conversation_id TEXT NOT NULL,
  text TEXT NOT NULL,          -- may be empty: the row stays so its revision keeps growing
  revision INTEGER NOT NULL,   -- grows with every change; a save or send based on an older one is refused
  state TEXT NOT NULL DEFAULT 'editable' CHECK (state IN ('editable', 'sending', 'unknown')),
  attempt TEXT,                -- the id of the message a send holds it for (the id the agent gets)
  updated_at TEXT NOT NULL,
  PRIMARY KEY (person_id, conversation_id),
  FOREIGN KEY (person_id, conversation_id) REFERENCES conversations (person_id, id),
  CHECK ((state = 'sending') = (attempt IS NOT NULL))
) STRICT;

-- The conversation Rufi opens the chat on for each person, the next time it
-- opens: the last choice a tab saved. Each open tab keeps its own. No row:
-- none yet.
CREATE TABLE chosen_conversations (
  person_id TEXT PRIMARY KEY REFERENCES people (id),
  conversation_id TEXT NOT NULL,
  FOREIGN KEY (person_id, conversation_id) REFERENCES conversations (person_id, id)
) STRICT;

-- One save to the record, made by the AI's call to save_changes in a
-- conversation. Its receipt is the transcript entry with the same id.
CREATE TABLE operations (
  id TEXT PRIMARY KEY,         -- UUIDv7
  person_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  call_id TEXT NOT NULL,       -- the agent's id for the call: the same call again is the same save
  request TEXT NOT NULL,       -- the changes as the AI sent them (JSON)
  created_at TEXT NOT NULL,
  UNIQUE (person_id, id),
  UNIQUE (conversation_id, call_id),
  FOREIGN KEY (person_id, conversation_id) REFERENCES conversations (person_id, id)
) STRICT;

-- Each record a save changed: the whole row before and after (JSON), so it
-- can be seen and changed back.
CREATE TABLE record_changes (
  operation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,        -- 1, 2, 3... in the save
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- the record's kind: 'medicine_use', 'symptom'...
  record_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('add', 'change', 'remove', 'restore')),
  before TEXT,                 -- null when added
  after TEXT NOT NULL,
  source_entry_id TEXT NOT NULL,
  PRIMARY KEY (operation_id, seq),
  FOREIGN KEY (person_id, operation_id) REFERENCES operations (person_id, id),
  FOREIGN KEY (person_id, source_entry_id) REFERENCES transcript_entries (person_id, id)
) STRICT;

CREATE INDEX documents_by_file ON documents (file_id);
CREATE INDEX reports_by_document ON reports (person_id, document_id);
CREATE INDEX results_by_report ON results (person_id, report_id);
CREATE INDEX results_by_test ON results (person_id, test_name, unit, measured_at);
CREATE INDEX results_by_replaced ON results (person_id, replaces_id); -- current results leave out replaced ones
CREATE INDEX conversations_by_person ON conversations (person_id, created_at);
CREATE INDEX turns_by_conversation ON turns (person_id, conversation_id, started_at);
CREATE INDEX turns_by_status ON turns (status); -- running turns, found at start
CREATE INDEX entries_by_turn ON transcript_entries (person_id, turn_id);
CREATE INDEX operations_by_person ON operations (person_id, created_at);
CREATE INDEX changes_by_record ON record_changes (person_id, record_id);
