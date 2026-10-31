-- The provider a chat's chosen model runs on, kept with the choice: after a
-- restart the providers may not list the model (Claude signed out lists
-- none), and the chat must stay on its provider. Every model chosen before
-- this ran on Codex, the only provider the app had.
ALTER TABLE chats ADD COLUMN model_provider TEXT;
UPDATE chats SET model_provider = 'codex' WHERE model IS NOT NULL;
