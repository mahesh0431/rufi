-- An agent says when it waits (status 'waiting'), and for what: the answer
-- to the question it asked its parent, or a sign-in to start. Its parent
-- hears of a start held as signed out (queue.about 'signed_out'). SQLite
-- can't change a CHECK in place, so agents and queue are made again, as
-- SQLite's own steps for other changes to a table say; the migration runs
-- with foreign keys off, and checks them before it commits (src/store.ts).

CREATE TABLE agents_new (
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
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'continuing', 'waiting', 'done', 'stopped', 'failed')), -- idle: not started yet; continuing: its turn was cut by a restart and it goes on; waiting: as `waiting` says; done: finished
  result TEXT,                   -- its latest result: its last answer, or why it stopped or failed
  stopped_by TEXT,               -- who stopped it, as the host names them: the person, an agent's id, a restart
  continues INTEGER NOT NULL DEFAULT 0, -- automatic continues in a row, after restarts
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  waiting TEXT CHECK (waiting IN ('asked', 'signed_out')), -- what a waiting agent waits for: the answer to its question to its parent, or a sign-in to start
  CHECK ((parent_id IS NULL) = (root_id = id)),
  CHECK ((status = 'stopped') = (stopped_by IS NOT NULL)),
  CHECK ((status = 'waiting') = (waiting IS NOT NULL))
) STRICT;

INSERT INTO agents_new (id, parent_id, root_id, title, provider, model, effort, tools, cwd, provider_ref, conversation, admitted, status, result, stopped_by, continues, created_at, updated_at)
SELECT id, parent_id, root_id, title, provider, model, effort, tools, cwd, provider_ref, conversation, admitted, status, result, stopped_by, continues, created_at, updated_at FROM agents;

DROP TABLE agents;
ALTER TABLE agents_new RENAME TO agents;
CREATE INDEX agents_parent ON agents (parent_id);
CREATE INDEX agents_root ON agents (root_id);

CREATE TABLE queue_new (
  id TEXT PRIMARY KEY,           -- the input's stable id: the person's message id, the sender's call id, or continue:<turn id>
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  sender TEXT NOT NULL,          -- who sent it, as the host names them, or the sending agent's id
  kind TEXT NOT NULL CHECK (kind IN ('steer', 'queue')), -- steer: as soon as a turn can take it; queue: after this turn
  parts TEXT,                    -- what is sent (JSON array of strings), as written; null when the host keeps the words and gives them as it hands the input over
  position INTEGER NOT NULL,     -- its order among the agent's inputs
  state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'handing_over', 'delivered', 'removed')), -- delivered: sent, from its hand-over on
  held TEXT CHECK (held IN ('signed_out', 'open_failed', 'failed', 'stopped', 'restarts')), -- a waiting input that isn't handed over by itself, and why
  held_text TEXT,                -- the hold's one line
  conversation INTEGER,          -- the agent's conversation number it was handed to
  turn_id TEXT REFERENCES turns (id) ON DELETE CASCADE, -- the turn that took it
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  about TEXT CHECK (about IN ('done', 'stopped', 'failed', 'asked', 'wrote', 'signed_out')), -- why another agent's input came: its turn's end, its question, a start held as signed out, or what it wrote
  said TEXT,                     -- what the sending agent said, in its own words
  CHECK (held IS NULL OR state = 'waiting')
) STRICT;

INSERT INTO queue_new SELECT id, agent_id, sender, kind, parts, position, state, held, held_text, conversation, turn_id, created_at, updated_at, about, said FROM queue;

DROP TABLE queue;
ALTER TABLE queue_new RENAME TO queue;
CREATE INDEX queue_agent ON queue (agent_id, state, position);
CREATE INDEX queue_turn ON queue (turn_id);
