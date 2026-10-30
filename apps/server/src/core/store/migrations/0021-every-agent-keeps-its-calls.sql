-- Every agent's calls to Rufi's tools: each kept by Rufi's id for it,
-- <agent>/<conversation>/<provider call id>, with the agent and its turn in
-- the agent database as plain ids, never a key across the two databases.
-- A call is a reply's only when it is a root turn's, so its reply may be
-- none. A call kept before has the agent's own id for it and no agent. The
-- table is made again, as SQLite does it: new table, copy, drop, rename.
CREATE TABLE tool_calls_new (
  id TEXT PRIMARY KEY,         -- UUIDv7
  person_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  turn_id TEXT,                -- the reply it belongs to: a root turn's call
  agent_id TEXT,               -- the agent that made it, in agents.sqlite; none for a call kept before
  agent_turn_id TEXT,          -- that agent's turn, in agents.sqlite
  call_id TEXT NOT NULL,       -- Rufi's id for the call: <agent>/<conversation>/<provider call id>; the agent's own for a call kept before
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

INSERT INTO tool_calls_new (id, person_id, chat_id, turn_id, call_id, tool, input, answer, ok, started_at, ended_at)
  SELECT id, person_id, chat_id, turn_id, call_id, tool, input, answer, ok, started_at, ended_at
  FROM tool_calls ORDER BY rowid;

DROP TABLE tool_calls;
ALTER TABLE tool_calls_new RENAME TO tool_calls;
CREATE INDEX tool_calls_by_turn ON tool_calls (person_id, turn_id);
