// Asha's open work, for the backup, restore and export tests: an open
// question, one on Later, and a task done by a save and then reopened, each
// with its history. Every value is made up. Run after Asha is in `people`.
export const OPEN_WORK = `
  INSERT INTO chats (id, person_id, created_at) VALUES ('c-asha', 'asha', '2026-10-01T09:00:00.000Z');
  INSERT INTO turns (id, person_id, chat_id, agent_turn_id, thread_id, model, status, started_at)
    VALUES ('t-1', 'asha', 'c-asha', 'agent-1', 'thread-1', 'gpt-6.1-sol', 'completed', '2026-10-01T09:00:00.000Z');
  INSERT INTO operations (id, seq, person_id, chat_id, call_id, request, created_at)
    VALUES ('op-1', 1, 'asha', 'c-asha', 'call-save', '{}', '2026-10-02T09:00:00.000Z');
  INSERT INTO open_items (id, person_id, chat_id, turn_id, kind, text, refs, status, show_again_at, version, created_at, updated_at)
    VALUES ('item-open', 'asha', 'c-asha', 't-1', 'question', 'Save HbA1c 6.1 % from 12 Mar 2026?', '[]', 'open', NULL, 1, '2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z'),
           ('item-later', 'asha', 'c-asha', 't-1', 'question', 'Add a follow-up "Repeat HbA1c", due December 2026?', '[]', 'open', '2026-10-08T22:00:00.000Z', 2, '2026-10-01T09:00:00.000Z', '2026-10-01T10:00:00.000Z'),
           ('item-reopened', 'asha', 'c-asha', 't-1', 'task', 'Compare the last three lipid panels', '[]', 'open', NULL, 3, '2026-10-01T09:00:00.000Z', '2026-10-03T09:00:00.000Z');
  INSERT INTO open_item_changes (person_id, item_id, version, at, by, change, chat_id, call_id, turn_id, request, status, show_again_at, outcome, operation_id)
    VALUES ('asha', 'item-open', 1, '2026-10-01T09:00:00.000Z', 'ai', 'added', 'c-asha', 'call-1', 't-1', '{"change":"add"}', 'open', NULL, NULL, NULL),
           ('asha', 'item-later', 1, '2026-10-01T09:00:00.000Z', 'ai', 'added', 'c-asha', 'call-2', 't-1', '{"change":"add"}', 'open', NULL, NULL, NULL),
           ('asha', 'item-later', 2, '2026-10-01T10:00:00.000Z', 'person', 'later', NULL, NULL, NULL, NULL, 'open', '2026-10-08T22:00:00.000Z', NULL, NULL),
           ('asha', 'item-reopened', 1, '2026-10-01T09:00:00.000Z', 'ai', 'added', 'c-asha', 'call-3', 't-1', '{"change":"add"}', 'open', NULL, NULL, NULL),
           ('asha', 'item-reopened', 2, '2026-10-02T09:00:00.000Z', 'ai', 'done', 'c-asha', 'call-4', 't-1', '{"change":"close"}', 'done', NULL, 'Compared', 'op-1'),
           ('asha', 'item-reopened', 3, '2026-10-03T09:00:00.000Z', 'person', 'reopened', NULL, NULL, NULL, NULL, 'open', NULL, NULL, NULL);
`;
