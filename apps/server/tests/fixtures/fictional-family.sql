-- A fictional family for tests and live tries. Every name and value is made up.
-- Load into a test folder (never the real one):
--   cat apps/server/src/core/store/schema.sql apps/server/tests/fixtures/fictional-family.sql | sqlite3 "$RUFI_HOME/rufi.sqlite"

INSERT INTO people (id, display_name) VALUES
  ('asha', 'Asha Fictional'),
  ('ravi', 'Ravi Fictional');

INSERT INTO chats (id, person_id, created_at) VALUES
  ('c-asha', 'asha', '2026-10-01T09:00:00Z'),
  ('c-ravi', 'ravi', '2026-10-01T09:00:00Z');

-- The files' bytes are in tests/fixtures/documents (golden.ts copies them).
INSERT INTO files (id, size, media_type, created_at) VALUES
  ('7f4a70ccb858d23ee1cce44693bc2c009abb14604f0f3dbd48470639d6928b54', 17196, 'application/pdf', '2026-08-13T09:00:00Z'),
  ('a2d64c4aa2a3101f1fc2ee893451ca0f43f547ca48ba5a1ce625c42d52e23562', 30740, 'image/jpeg', '2026-09-02T18:30:00Z'),
  ('f7d7c195033e1719e2c191970b14e52478e02faf51f1d61e57b517674fbc9c45', 16150, 'application/pdf', '2026-07-01T08:00:00Z');

INSERT INTO documents (id, person_id, added_at, added_from) VALUES
  ('doc-asha-aug', 'asha', '2026-08-13T09:00:00Z', 'documents_page'),
  ('doc-asha-sep', 'asha', '2026-09-02T18:30:00Z', 'documents_page'),
  ('doc-ravi-jul', 'ravi', '2026-07-01T08:00:00Z', 'documents_page');

INSERT INTO document_pages (person_id, document_id, position, file_id, page_in_file, file_name) VALUES
  ('asha', 'doc-asha-aug', 1, '7f4a70ccb858d23ee1cce44693bc2c009abb14604f0f3dbd48470639d6928b54', 1, 'Sunrise Labs August.pdf'),
  ('asha', 'doc-asha-aug', 2, '7f4a70ccb858d23ee1cce44693bc2c009abb14604f0f3dbd48470639d6928b54', 2, 'Sunrise Labs August.pdf'),
  ('asha', 'doc-asha-sep', 1, 'a2d64c4aa2a3101f1fc2ee893451ca0f43f547ca48ba5a1ce625c42d52e23562', 1, 'thyroid recheck.jpg'),
  ('ravi', 'doc-ravi-jul', 1, 'f7d7c195033e1719e2c191970b14e52478e02faf51f1d61e57b517674fbc9c45', 1, 'Ravi lipid panel.pdf');

INSERT INTO reports (id, person_id, document_id, issuer, collected) VALUES
  ('rep-asha-aug', 'asha', 'doc-asha-aug', 'Sunrise Labs', '2026-08-12'),
  ('rep-asha-sep', 'asha', 'doc-asha-sep', 'Sunrise Labs', '2026-09-01'),
  ('rep-ravi-jul', 'ravi', 'doc-ravi-jul', 'Lakeside Diagnostics', '2026-06-30');

-- Every result is a lab result or a measurement, as the AI and the person chose.
INSERT INTO results (id, person_id, report_id, category, test_name, value_text, comparator, value_number,
                     unit, reference_range, flag_text, context_text, measured_at, entered_at, replaces_id) VALUES
  ('res-a1', 'asha', 'rep-asha-aug', 'lab', 'HbA1c', '6.8', NULL, 6.8, '%', '4.0 - 5.6', 'High', NULL, '2026-08-12', '2026-08-13T09:01:00Z', NULL),
  ('res-a2', 'asha', 'rep-asha-aug', 'lab', 'Glucose', '118', NULL, 118, 'mg/dL', '70 - 99', 'High', 'Fasting', '2026-08-12', '2026-08-13T09:01:00Z', NULL),
  ('res-a3', 'asha', 'rep-asha-aug', 'lab', 'CRP', '<5', '<', 5, 'mg/L', '<10', NULL, NULL, '2026-08-12', '2026-08-13T09:01:00Z', NULL),
  ('res-a4', 'asha', 'rep-asha-aug', 'lab', 'TSH', '2.1', NULL, 2.1, 'mIU/L', '0.4 - 4.0', NULL, NULL, '2026-08-12', '2026-08-13T09:01:00Z', NULL),
  -- The lab corrected the TSH value: the amended result replaces the first one.
  ('res-a5', 'asha', 'rep-asha-sep', 'lab', 'TSH', '4.6', NULL, 4.6, 'mIU/L', '0.4 - 4.0', 'High', NULL, '2026-08-12', '2026-09-02T18:31:00Z', 'res-a4'),
  ('res-a6', 'asha', 'rep-asha-sep', 'lab', 'Free T4', '1.1', NULL, 1.1, 'ng/dL', '0.8 - 1.8', NULL, 'Direct', '2026-09-01', '2026-09-02T18:31:00Z', NULL),
  -- Typed in: only the month is known, and one with no date at all.
  ('res-a7', 'asha', NULL, 'lab', 'Vitamin D', '22', NULL, 22, 'ng/mL', '30 - 100', 'Low', NULL, '2026-05', '2026-09-10T10:00:00Z', NULL),
  ('res-a8', 'asha', NULL, 'lab', 'Blood group', 'B positive', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-09-10T10:05:00Z', NULL),
  -- Measurements typed in the chat: a blood pressure and two weights, one known only by its month.
  ('res-a9', 'asha', NULL, 'measurement', 'Blood pressure', '128/84', NULL, NULL, 'mmHg', NULL, NULL, NULL, '2026-09-20', '2026-09-20T19:00:00Z', NULL),
  ('res-a10', 'asha', NULL, 'measurement', 'Weight', '61.5', NULL, 61.5, 'kg', NULL, NULL, NULL, '2026-09-20', '2026-09-20T19:01:00Z', NULL),
  ('res-a11', 'asha', NULL, 'measurement', 'Weight', '62', NULL, 62, 'kg', NULL, NULL, NULL, '2026-08', '2026-09-20T19:02:00Z', NULL),
  ('res-r1', 'ravi', 'rep-ravi-jul', 'lab', 'LDL cholesterol', '162', NULL, 162, 'mg/dL', '<100', 'High', 'Calculated', '2026-06-30', '2026-07-01T08:01:00Z', NULL),
  ('res-r2', 'ravi', 'rep-ravi-jul', 'lab', 'HDL cholesterol', '41', NULL, 41, 'mg/dL', '>40', NULL, NULL, '2026-06-30', '2026-07-01T08:01:00Z', NULL);

-- The results read from documents point to their page.
INSERT INTO record_sources (person_id, kind, record_id, type, document_id, page) VALUES
  ('asha', 'result', 'res-a1', 'document_page', 'doc-asha-aug', 1),
  ('asha', 'result', 'res-a2', 'document_page', 'doc-asha-aug', 1),
  ('asha', 'result', 'res-a3', 'document_page', 'doc-asha-aug', 2),
  ('asha', 'result', 'res-a4', 'document_page', 'doc-asha-aug', 2),
  ('asha', 'result', 'res-a5', 'document_page', 'doc-asha-sep', 1),
  ('asha', 'result', 'res-a6', 'document_page', 'doc-asha-sep', 1),
  ('ravi', 'result', 'res-r1', 'document_page', 'doc-ravi-jul', 1),
  ('ravi', 'result', 'res-r2', 'document_page', 'doc-ravi-jul', 1);

-- Records from before Rufi kept their source (none given).
INSERT INTO medicine_uses (id, person_id, name, strength, amount, schedule, route, purpose, status, started, started_words) VALUES
  ('med-a1', 'asha', 'Metformin', '500 mg', '1 tablet', 'twice a day', 'by mouth', 'blood sugar', 'current', '2024-03', NULL),
  ('med-a2', 'asha', 'Creatine', '5 g', NULL, 'every morning', NULL, NULL, 'current', '2026-06', NULL),
  ('med-r1', 'ravi', 'Atorvastatin', '10 mg', '1 tablet', 'at night', 'by mouth', 'cholesterol', 'current', '2026-07', NULL);

INSERT INTO allergies (id, person_id, substance, reaction, status, certainty, asserted) VALUES
  ('all-r1', 'ravi', 'Penicillin', 'rash', 'active', 'confirmed', '2025-02-10');
