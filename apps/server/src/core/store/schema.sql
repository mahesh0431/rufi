-- Rufi's one database. Connections must run `PRAGMA foreign_keys = ON`.
--
-- Person scope is a relation, not just a column: every person-owned row carries
-- person_id, and references between person-owned rows go through composite
-- foreign keys (person_id, id), so a row for one person can never point at
-- another person's row. File bytes are shared and carry no person.
--
-- Dates are text at the precision they were known: 'YYYY', 'YYYY-MM' or
-- 'YYYY-MM-DD' (times as ISO 8601). Values are stored as printed.

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
  UNIQUE (person_id, id),
  FOREIGN KEY (person_id, report_id) REFERENCES reports (person_id, id),
  FOREIGN KEY (person_id, replaces_id) REFERENCES results (person_id, id)
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
  title TEXT NOT NULL,
  provider TEXT NOT NULL,      -- the agent chosen for it: 'codex'
  model TEXT NOT NULL,         -- the model chosen for it
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
  end_reason TEXT CHECK (end_reason IN ('stopped', 'timeout', 'usage_limit', 'rate_limit', 'sign_in', 'connection', 'provider_failed')),
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
  kind TEXT NOT NULL CHECK (kind IN ('message', 'steer', 'activity', 'reply')),
  text TEXT NOT NULL,          -- the message or the reply; an activity's short title
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

-- One unsent message per conversation, and one per person for a new
-- conversation (conversation_id null). Rufi never sends a draft.
CREATE TABLE drafts (
  person_id TEXT NOT NULL REFERENCES people (id),
  conversation_id TEXT,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (person_id, conversation_id) REFERENCES conversations (person_id, id)
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
CREATE UNIQUE INDEX drafts_one_each ON drafts (person_id, ifnull(conversation_id, ''));
