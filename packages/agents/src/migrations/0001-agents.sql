-- The agent database (agents.sqlite), as its first version made it: the
-- agents, their turns and steps, the one queue every agent's inputs wait in,
-- the receipts of the agent tools, and the event log. It knows no people,
-- documents or health: the host maps its own ids to agents. Every change
-- writes its event in the same transaction (src/store.ts).

-- The file's generation: a random id made with it. The host keeps its place
-- in the event log as (generation, number), so a new file, made when the old
-- one was lost, is never taken for the old one.
CREATE TABLE meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation TEXT NOT NULL
) STRICT;

INSERT INTO meta (id, generation) VALUES (1, lower(hex(randomblob(16))));

-- One agent: a chat's root (Rufi AI) or a sub-agent at any depth.
CREATE TABLE agents (
  id TEXT PRIMARY KEY,           -- given by the host: the starting call's id, or the host's own for a root
  parent_id TEXT REFERENCES agents (id) ON DELETE CASCADE, -- null for a root
  root_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE, -- the tree's root; a root's own id
  title TEXT NOT NULL,           -- "Rufi AI", "Reading report.pdf"
  provider TEXT NOT NULL,        -- the adapter its next turn uses (its ProviderAdapter id)
  model TEXT NOT NULL,           -- what its next turn uses
  effort TEXT NOT NULL,
  tools TEXT NOT NULL,           -- the host's tools it may use (JSON array of names), never more than its parent's
  cwd TEXT NOT NULL,             -- its working folder
  provider_ref TEXT,             -- its provider conversation, once one is open
  conversation INTEGER NOT NULL DEFAULT 0, -- that conversation's number: 1 for the first, one more each time a new one replaces it, 0 before any
  admitted INTEGER NOT NULL DEFAULT 0 CHECK (admitted IN (0, 1)), -- 1 once the host keeps its owner: an agent not admitted never runs
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'continuing', 'done', 'stopped', 'failed')), -- idle: no turn yet; continuing: its turn was cut by a restart and it goes on
  result TEXT,                   -- its latest result: its last answer, or why it stopped or failed
  stopped_by TEXT,               -- who stopped it, as the host names them: the person, an agent's id, a restart
  continues INTEGER NOT NULL DEFAULT 0, -- automatic continues in a row, after restarts
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((parent_id IS NULL) = (root_id = id)),
  CHECK ((status = 'stopped') = (stopped_by IS NOT NULL))
) STRICT;

CREATE INDEX agents_parent ON agents (parent_id);
CREATE INDEX agents_root ON agents (root_id);

-- One turn of an agent's conversation, with what it ran on. Its inputs are
-- the queue rows that name it.
CREATE TABLE turns (
  id TEXT PRIMARY KEY,           -- the package's id for it
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  conversation INTEGER NOT NULL, -- the agent's conversation number it ran in
  provider_turn TEXT,            -- the provider's reference for it, once it started
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'stopping', 'done', 'stopped', 'failed')), -- stopping: closed to new calls, its stop under way
  reason TEXT,                   -- why it stopped or failed: the provider's reason (signed_out, usage_limit...) or the host's (a restart)
  result TEXT,                   -- its final answer whole, or the provider's words when it failed
  usage TEXT,                    -- the context it used, as reported (JSON)
  started_at TEXT NOT NULL,
  ended_at TEXT,
  CHECK ((status IN ('done', 'stopped', 'failed')) = (ended_at IS NOT NULL))
) STRICT;

CREATE INDEX turns_agent ON turns (agent_id, started_at);

-- What happened in a turn, as the provider reported it: its answer, notes,
-- questions, reasoning and steps, each by the provider's item id.
CREATE TABLE items (
  turn_id TEXT NOT NULL REFERENCES turns (id) ON DELETE CASCADE,
  id TEXT NOT NULL,              -- the provider's item id
  position INTEGER NOT NULL,     -- its order in the turn, as first reported
  type TEXT NOT NULL CHECK (type IN ('text', 'note', 'question', 'reasoning', 'step')),
  kind TEXT,                     -- a step's kind (tool, command, web_search...)
  title TEXT,                    -- a step's or question's title
  detail TEXT,                   -- a step's detail (the command, the tool's arguments)
  status TEXT CHECK (status IN ('running', 'done', 'failed')), -- a step's
  text TEXT,                     -- an answer, note or reasoning summary, whole
  payload TEXT,                  -- all the provider gave about it (JSON), images left out
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (turn_id, id),
  UNIQUE (turn_id, position)
) STRICT;

-- Every input waiting for an agent, being handed over, or settled: the
-- person's messages, Rufi's notes, other agents' messages, and continues.
CREATE TABLE queue (
  id TEXT PRIMARY KEY,           -- the input's stable id: the person's message id, the sender's call id, or continue:<turn id>
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  sender TEXT NOT NULL,          -- who sent it, as the host names them, or the sending agent's id
  kind TEXT NOT NULL CHECK (kind IN ('steer', 'queue')), -- steer: as soon as a turn can take it; queue: after this turn
  parts TEXT,                    -- what is sent (JSON array of strings), as written; null when the host keeps the words and gives them as it hands the input over
  position INTEGER NOT NULL,     -- its order among the agent's inputs
  state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'handing_over', 'delivered', 'not_sure', 'dropped', 'removed')),
  held TEXT CHECK (held IN ('signed_out', 'open_failed', 'failed', 'restarts')), -- a waiting input that isn't handed over by itself, and why
  held_text TEXT,                -- the hold's one line
  conversation INTEGER,          -- the agent's conversation number it was handed to
  turn_id TEXT REFERENCES turns (id) ON DELETE CASCADE, -- the turn that took it
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (held IS NULL OR state = 'waiting')
) STRICT;

CREATE INDEX queue_agent ON queue (agent_id, state, position);
CREATE INDEX queue_turn ON queue (turn_id);

-- What each call to an agent tool answered, by the host's call id, so a
-- repeat gets the same answer and changes nothing.
CREATE TABLE receipts (
  call_id TEXT PRIMARY KEY,      -- the host's call id: <agent>/<conversation>/<provider call id>
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE, -- the calling agent
  tool TEXT NOT NULL,
  answer TEXT NOT NULL,          -- what it answered (JSON)
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX receipts_agent ON receipts (agent_id);

-- The event log: one row per change, written in the change's transaction,
-- read by the host after its cursor. A number is never used twice, even
-- after a forget deletes an agent's events.
CREATE TABLE events (
  number INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  agent_id TEXT REFERENCES agents (id) ON DELETE CASCADE, -- the agent it is about, if one
  payload TEXT NOT NULL,         -- what changed (JSON)
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX events_agent ON events (agent_id);
