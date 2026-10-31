-- Each reply keeps the effort it ran with, beside its model, as Rufi passed
-- it: the chat says so when the model or the effort changes between
-- replies. Replies from before have none: their effort is unknown.
ALTER TABLE turns ADD COLUMN effort TEXT;
