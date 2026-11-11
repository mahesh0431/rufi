-- Why an input from one agent to another came: the done message of a turn
-- that ended done, stopped or failed, or asked a question; or a message the
-- agent wrote. Null for the host's own inputs.
ALTER TABLE queue ADD COLUMN about TEXT CHECK (about IN ('done', 'stopped', 'failed', 'asked', 'wrote'));
