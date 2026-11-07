-- A reply has no buttons or follow-ups any more, so a message is what Rufi
-- AI gets: its words as shown. A message that isn't the box's says so when
-- it is sent, and needs nothing kept.
ALTER TABLE chat_queue DROP COLUMN ai_text;
ALTER TABLE transcript_entries DROP COLUMN ai_text;
