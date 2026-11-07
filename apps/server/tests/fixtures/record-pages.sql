-- More of Asha's fictional record, after fictional-family.sql: a row of each
-- kind the record pages show, follow-ups in groups that don't move with the
-- day (long overdue, years ahead, at the next visit, done), two saves with
-- their history, and one row that doesn't fit its shape. The iPhone's
-- fixtures (ios-fixtures.test.ts) and its Simulator door (apps/ios/scripts/
-- door.ts) read it. Every name and value is made up.

INSERT INTO conditions (id, person_id, name, certainty, status, recognised, details) VALUES
  ('cond-a1', 'asha', 'Type 2 diabetes', 'diagnosed', 'ongoing', '2024-03', 'Diet and Metformin'),
  ('cond-a2', 'asha', 'Iron deficiency anaemia', 'diagnosed', 'resolved', '2021', NULL),
  -- A date that isn't one: the row can't be shown.
  ('cond-a3', 'asha', 'Thyroid trouble', 'suspected', 'ongoing', '13/2025', NULL);

-- An allergy she had, and her saying she has none now.
INSERT INTO allergies (id, person_id, substance, reaction, status, certainty, reacted) VALUES
  ('all-a1', 'asha', 'Penicillin', 'rash', 'inactive', 'confirmed', '2019');

INSERT INTO none_known (id, person_id, category, asserted) VALUES
  ('nk-a1', 'asha', 'allergies', '2026-10-10');

INSERT INTO symptoms (id, person_id, name, status, onset, severity, location, intermittent) VALUES
  ('sym-a1', 'asha', 'Headache', 'ongoing', '2026-10-28', 'mild', 'forehead', 1);

INSERT INTO care_events (id, person_id, type, name, status, date, provider) VALUES
  ('care-a1', 'asha', 'immunisation', 'Flu vaccine', 'done', '2026-10-05', 'Lakeview Family Clinic');

INSERT INTO follow_ups (id, person_id, title, due, status, outcome, linked_kind, linked_id) VALUES
  ('fu-a1', 'asha', 'Repeat HbA1c', '2020-02', 'open', NULL, 'result', 'res-a1'),
  ('fu-a2', 'asha', 'Ask about the headaches', 'next_visit', 'open', NULL, 'symptom', 'sym-a1'),
  ('fu-a3', 'asha', 'Dental cleaning', '2099-03', 'open', NULL, NULL, NULL),
  ('fu-a4', 'asha', 'Vitamin D recheck', '2026-10-01', 'done', 'Done at Sunrise Labs', 'result', 'res-a7');

-- Two saves: the diabetes added, then its status changed.
INSERT INTO operations (id, seq, person_id, origin, chat_id, call_id, request, receipt, created_at) VALUES
  ('op-a1', 1, 'asha', 'chat', 'c-asha', 'call-a1', '{}', '**Saved**

- Added condition Type 2 diabetes', '2026-10-02T10:00:00Z'),
  ('op-a2', 2, 'asha', 'chat', 'c-asha', 'call-a2', '{}', '**Saved**

- Changed condition Type 2 diabetes: status ongoing', '2026-10-03T11:30:00Z');

INSERT INTO record_changes (operation_id, seq, person_id, kind, record_id, action, before, after) VALUES
  ('op-a1', 1, 'asha', 'condition', 'cond-a1', 'add', NULL,
   '{"name":"Type 2 diabetes","certainty":"diagnosed","status":"unknown","recognised":"2024-03"}'),
  ('op-a2', 1, 'asha', 'condition', 'cond-a1', 'change',
   '{"name":"Type 2 diabetes","certainty":"diagnosed","status":"unknown","recognised":"2024-03"}',
   '{"name":"Type 2 diabetes","certainty":"diagnosed","status":"ongoing","recognised":"2024-03"}');

INSERT INTO record_sources (person_id, kind, record_id, type, document_id, page, operation_id) VALUES
  ('asha', 'condition', 'cond-a1', 'document_page', 'doc-asha-aug', 1, 'op-a1');
