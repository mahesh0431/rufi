-- Rufi's waiting messages go to the agent system's queue, which hands them
-- over in order (server/chat.ts), and a chat no longer pauses after a Stop
-- or a restart. What an older Rufi left, mapped once:
-- - a chat's pause ends, and a Rufi note held for it waits free;
-- - a hand-over that Rufi marked (its id in sent_as) may have reached the
--   AI: it is not sure, keeping sent_as, and never goes again by itself.
-- A hand-over Rufi didn't mark is settled at every start, as before
-- (core/chat/queue.ts, endStopped). A row held from a restored backup, or
-- for the person's choice, stays held; sent and removed rows stay as they are.
UPDATE chats SET paused = NULL;
UPDATE chat_queue SET held = NULL WHERE state = 'waiting' AND held = 'paused';
UPDATE chat_queue SET state = 'not_sure'
  WHERE state = 'handing_over' AND sent_as IS NOT NULL;
