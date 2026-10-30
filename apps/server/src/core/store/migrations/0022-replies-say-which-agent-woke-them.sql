-- A reply Rufi AI gave by itself, woken by a message from an agent it
-- started, keeps which agent (its title) and why, as JSON: {"title",
-- "about": done, stopped, failed, asked or wrote}. Its small "why" line
-- stays when the agent database is lost.
ALTER TABLE turns ADD COLUMN cause TEXT CHECK (cause IS NULL OR json_valid(cause));
