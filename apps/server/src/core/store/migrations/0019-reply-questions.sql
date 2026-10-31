-- A reply's questions, kept apart from its answer's text: the AI asks them
-- on the same item as its answer, and making a cut answer whole from the
-- agent system's events must never drop them (server/rufi-ai.ts). JSON:
-- [{ "title": ..., "options": [...] }], as the AI gave them.
ALTER TABLE transcript_entries ADD COLUMN questions TEXT
  CHECK (questions IS NULL OR kind = 'reply');
