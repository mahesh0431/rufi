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
  ('fu-a4', 'asha', 'Vitamin D recheck', '2026-10-01', 'done', 'Done at Sunrise Labs', 'result', 'res-a7'),
  -- About the TSH the lab amended since (res-a4, replaced by res-a5).
  ('fu-a5', 'asha', 'Recheck TSH', '2099-06', 'open', NULL, 'result', 'res-a4');

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

-- Metformin's times and reminders, and some of its doses in early October:
-- taken on the iPhone (one arriving late), skipped on the Mac, told to Rufi
-- AI, and one taken then undone.
UPDATE medicine_uses SET times = '["08:00","20:00"]', remind = 1 WHERE id = 'med-a1';

INSERT INTO dose_log (id, person_id, medicine_use_id, dose_at, state, taken_at, logged_at, received_at, logged_by) VALUES
  ('dose-a1', 'asha', 'med-a1', '2026-10-05T08:00', 'taken', '2026-10-05T02:42:00.000Z', '2026-10-05T02:42:00.000Z', '2026-10-05T02:42:01.000Z', 'app:app-asha'),
  ('dose-a2', 'asha', 'med-a1', '2026-10-05T20:00', 'skipped', NULL, '2026-10-05T14:40:00.000Z', '2026-10-05T14:40:00.000Z', 'mac'),
  ('dose-a3', 'asha', 'med-a1', '2026-10-06T08:00', 'taken', '2026-10-06T02:35:00.000Z', '2026-10-06T02:36:00.000Z', '2026-10-06T13:32:00.000Z', 'app:app-asha'),
  ('dose-a4', 'asha', 'med-a1', '2026-10-06T20:00', 'taken', '2026-10-06T14:45:00.000Z', '2026-10-06T15:00:00.000Z', '2026-10-06T15:00:00.000Z', 'rufi_ai'),
  ('dose-a5', 'asha', 'med-a1', '2026-10-06T20:00', 'cleared', NULL, '2026-10-06T15:05:00.000Z', '2026-10-06T15:05:00.000Z', 'mac');

-- A visit, with the doctor's words, and the flu vaccine saved from it.
INSERT INTO visits (id, person_id, setting, date, doctor, place, reason, as_written) VALUES
  ('vis-a1', 'asha', 'clinic', '2026-10-05', 'Dr A. Fictional', 'Lakeview Family Clinic', 'Diabetes review',
   '**Diabetes review**

- HbA1c 6.8 %, above target
- Flu vaccine given today
- Continue Metformin 500 mg twice a day');

INSERT INTO record_sources (person_id, kind, record_id, type, visit_id) VALUES
  ('asha', 'care_event', 'care-a1', 'visit', 'vis-a1');

-- A reading of Asha's August report, done and sorted: page 1 read, with
-- its copy and three draft items not saved yet (one fixed by her, one
-- worth a look, one an earlier value); page 2 has nothing to read.
INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, started_at, run_at, ended_at, created_at) VALUES
  ('job-aug', 'asha', 'document_read', 'doc-asha-aug', 'done', 1, '[1,2]', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z', '2026-10-01T09:02:00Z', '2026-10-01T09:00:00Z');
UPDATE document_pages SET state = 'read', entry_job_id = 'job-aug', entry_attempt = 1, entry_at = '2026-10-01T09:01:00Z'
  WHERE person_id = 'asha' AND document_id = 'doc-asha-aug' AND position = 1;
UPDATE document_pages SET state = 'nothing_here', entry_job_id = 'job-aug', entry_attempt = 1, entry_at = '2026-10-01T09:02:00Z'
  WHERE person_id = 'asha' AND document_id = 'doc-asha-aug' AND position = 2;
UPDATE documents SET version = 2, kind = 'lab_report', issuer = 'Sunrise Labs', date = '2026-08-12'
  WHERE person_id = 'asha' AND id = 'doc-asha-aug';
INSERT INTO page_copies (person_id, file_id, page_in_file, job_id, attempt, outcome, copy, saved_at, sorted_at) VALUES
  ('asha', '7f4a70ccb858d23ee1cce44693bc2c009abb14604f0f3dbd48470639d6928b54', 1, 'job-aug', 1, 'read',
   'Sunrise Labs · Collected 12 Aug 2026

| Test | Result | Unit | Range |
| --- | --- | --- | --- |
| Haemoglobin | 13.2 | g/dL | 12.0–15.5 |
| LDL cholesterol | 3.4 H | mmol/L | < 3.0 |
| HbA1c (previous) | 7.1 | % | |', '2026-10-01T09:01:00Z', '2026-10-01T09:03:00Z'),
  ('asha', '7f4a70ccb858d23ee1cce44693bc2c009abb14604f0f3dbd48470639d6928b54', 2, 'job-aug', 1, 'nothing_here',
   '', '2026-10-01T09:02:00Z', '2026-10-01T09:03:00Z');
INSERT INTO draft_items (id, person_id, document_id, page, seq, job_id, kind, version, fields, original, unsure, quote, created_at) VALUES
  ('drf-a1', 'asha', 'doc-asha-aug', 1, 1, 'job-aug', 'lab_result', 2,
   '{"test_name":"Haemoglobin","value_text":"13.4","value_number":13.4,"unit":"g/dL","reference_range":"12.0–15.5","column":"current"}',
   '{"test_name":"Haemoglobin","value_text":"13.2","value_number":13.2,"unit":"g/dL","reference_range":"12.0–15.5","column":"current"}',
   '[]', 'Haemoglobin | 13.2 | g/dL | 12.0–15.5', '2026-10-01T09:03:00Z'),
  ('drf-a2', 'asha', 'doc-asha-aug', 1, 2, 'job-aug', 'lab_result', 1,
   '{"test_name":"LDL cholesterol","value_text":"3.4","value_number":3.4,"unit":"mmol/L","reference_range":"< 3.0","flag_text":"H","column":"current"}',
   '{"test_name":"LDL cholesterol","value_text":"3.4","value_number":3.4,"unit":"mmol/L","reference_range":"< 3.0","flag_text":"H","column":"current"}',
   '["The flag is faint on the page."]', 'LDL cholesterol | 3.4 H | mmol/L | < 3.0', '2026-10-01T09:03:00Z'),
  ('drf-a3', 'asha', 'doc-asha-aug', 1, 3, 'job-aug', 'lab_result', 1,
   '{"test_name":"HbA1c","value_text":"7.1","value_number":7.1,"unit":"%","column":"earlier"}',
   '{"test_name":"HbA1c","value_text":"7.1","value_number":7.1,"unit":"%","column":"earlier"}',
   '[]', 'HbA1c (previous) | 7.1 | %', '2026-10-01T09:03:00Z');

-- A reply in Asha's chat, as the chat stores one: her question, the AI's
-- thought and one step, and its answer with a visual (ADR 0034).
INSERT INTO turns (id, person_id, chat_id, agent_turn_id, model, status, started_at, ended_at, effort) VALUES
  ('turn-a1', 'asha', 'c-asha', 'agent-turn-a1', 'gpt-6-astra', 'completed', '2026-10-05T08:00:01Z', '2026-10-05T08:00:13Z', 'medium');
INSERT INTO transcript_entries (id, person_id, chat_id, seq, turn_id, kind, text, activity, detail, details, status, revision, created_at, updated_at) VALUES
  ('ent-a1', 'asha', 'c-asha', 1, NULL, 'message', 'How is my HbA1c doing?', NULL, NULL, NULL, NULL, 1, '2026-10-05T08:00:00Z', '2026-10-05T08:00:00Z'),
  ('ent-a2', 'asha', 'c-asha', 2, 'turn-a1', 'reasoning', '**Reading the record**

Asha''s HbA1c results, newest first.', NULL, NULL, NULL, NULL, 2, '2026-10-05T08:00:02Z', '2026-10-05T08:00:03Z'),
  ('ent-a3', 'asha', 'c-asha', 3, 'turn-a1', 'activity', 'ls', 'command', 'exit 0', '{"type":"commandExecution","command":"ls","aggregatedOutput":"notes.txt\n","exitCode":0,"durationMs":40}', 'done', 3, '2026-10-05T08:00:04Z', '2026-10-05T08:00:04Z'),
  ('ent-a4', 'asha', 'c-asha', 4, 'turn-a1', 'reply', 'Your **HbA1c** was 6.8 % on 12 Aug 2026, above the 4.0–5.6 range.

```rufi-visual
<p>6.8 %</p>
```

[See your HbA1c results](rufi:/tests/tst-hba1c)', NULL, NULL, NULL, 'done', 4, '2026-10-05T08:00:05Z', '2026-10-05T08:00:13Z');
UPDATE chats SET revision = 4 WHERE id = 'c-asha';

-- An older Rufi's reading of the September photo that failed partway: its
-- reader's entry for the page (no copy), with an issue it noted, and Rufi's
-- check that it may be incomplete.
INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, error, started_at, run_at, ended_at, created_at) VALUES
  ('job-sep', 'asha', 'document_read', 'doc-asha-sep', 'failed', 1, '[1]', 'The reader stopped before it finished.', '2026-09-02T18:31:00Z', '2026-09-02T18:31:00Z', '2026-09-02T18:33:00Z', '2026-09-02T18:31:00Z');
UPDATE document_pages SET entry_job_id = 'job-sep', entry_attempt = 1, entry_at = '2026-09-02T18:32:00Z',
  entry = '{"outcome":"read","facts":{"issuer":"Sunrise Labs","dates":[{"label":"Collected","date":"1 Sep 2026"}]},"rows_seen":2,"items":[{"test_name":"TSH","value_text":"4.6","unit":"mIU/L","reference_range":"0.4–4.0","flag_text":"H","unsure":"The value is faint."}],"issues":["The bottom of the photo is cut off."]}',
  entry_checks = '{"incomplete":{"rows_seen":2,"items":1},"items":[{"item":1,"why":"Its unit is not on the page."}]}'
  WHERE person_id = 'asha' AND document_id = 'doc-asha-sep' AND position = 1;
