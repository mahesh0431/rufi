-- The agent system keeps in step with the record (docs/adr/0024): each
-- agent's owner, every provider conversation a chat had, and how far Rufi
-- has applied the agent system's events. New tables only.
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

-- How far Rufi has applied the agent system's event log: the last event
-- applied, moved in the same transaction as that event's change. A new
-- agents.sqlite starts it again at 0.
CREATE TABLE agent_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  number INTEGER NOT NULL
) STRICT;
