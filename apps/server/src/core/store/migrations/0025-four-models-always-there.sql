-- Rufi offers four models, always, each with the same four efforts: low,
-- medium, high and xhigh (contracts' MODELS and EFFORTS). A chat's effort
-- may now be xhigh. A chat on another model (chosen before, when the
-- providers listed theirs) moves to GPT-6-Astra on Codex, a new chat's.
-- The shortlist setting goes: there is nothing to choose. The table is made
-- again, as SQLite does it: new table, copy, drop, rename.
CREATE TABLE chats_new (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL UNIQUE REFERENCES people (id),
  model TEXT,
  effort TEXT CHECK (effort IN ('low', 'medium', 'high', 'xhigh')),
  thread_id TEXT,
  thread_provider TEXT,
  thread_model TEXT,
  thread_tools TEXT,
  paused TEXT CHECK (paused IN ('stopped', 'restarted')),
  revision INTEGER NOT NULL DEFAULT 0,
  context_tokens INTEGER,
  context_window INTEGER,
  context_thread TEXT,
  created_at TEXT NOT NULL,
  model_provider TEXT,
  UNIQUE (person_id, id)
) STRICT;
INSERT INTO chats_new
  SELECT id, person_id, model, effort, thread_id, thread_provider,
    thread_model, thread_tools, paused, revision, context_tokens,
    context_window, context_thread, created_at, model_provider
  FROM chats;
DROP TABLE chats;
ALTER TABLE chats_new RENAME TO chats;
UPDATE chats SET model = 'gpt-6-astra', model_provider = 'codex'
  WHERE model IS NOT NULL
    AND model NOT IN ('gpt-6-astra', 'gpt-6.1-sol', 'claude-fable-5-1', 'claude-opus-5-5');
DELETE FROM settings WHERE key = 'models';
