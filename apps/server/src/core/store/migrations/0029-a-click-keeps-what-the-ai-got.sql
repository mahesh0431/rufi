-- A click on a reply's follow-up or button shows only its words as the
-- person's message, and Rufi AI gets "User clicked: …" with the form's
-- values and the action's context. A message keeps both: `text` as shown,
-- `ai_text` as Rufi AI got it; null when they're the same.
ALTER TABLE chat_queue ADD COLUMN ai_text TEXT;
ALTER TABLE transcript_entries ADD COLUMN ai_text TEXT;
