-- A fictional family for tests and live tries. Every name and value is made up.
-- Load into a test folder (never the real one):
--   cat apps/server/src/core/store/schema.sql apps/server/tests/fixtures/fictional-family.sql | sqlite3 "$RUFI_HOME/rufi.sqlite"

INSERT INTO people (id, display_name) VALUES
  ('asha', 'Asha Fictional'),
  ('ravi', 'Ravi Fictional');

INSERT INTO files (id, size, media_type, created_at) VALUES
  ('f1c710a1', 182344, 'application/pdf', '2026-08-13T09:00:00Z'),
  ('f1c710a2', 95112, 'image/jpeg', '2026-09-02T18:30:00Z'),
  ('f1c710a3', 120400, 'application/pdf', '2026-07-01T08:00:00Z');

INSERT INTO documents (id, person_id, file_id, original_name, added_at) VALUES
  ('doc-asha-aug', 'asha', 'f1c710a1', 'Sunrise Labs August.pdf', '2026-08-13T09:00:00Z'),
  ('doc-asha-sep', 'asha', 'f1c710a2', 'thyroid recheck.jpg', '2026-09-02T18:30:00Z'),
  ('doc-ravi-jul', 'ravi', 'f1c710a3', 'Ravi lipid panel.pdf', '2026-07-01T08:00:00Z');

INSERT INTO reports (id, person_id, document_id, issuer, collected) VALUES
  ('rep-asha-aug', 'asha', 'doc-asha-aug', 'Sunrise Labs', '2026-08-12'),
  ('rep-asha-sep', 'asha', 'doc-asha-sep', 'Sunrise Labs', '2026-09-01'),
  ('rep-ravi-jul', 'ravi', 'doc-ravi-jul', 'Lakeside Diagnostics', '2026-06-30');

INSERT INTO results (id, person_id, report_id, test_name, value_text, comparator, value_number,
                     unit, reference_range, flag_text, context_text, measured_at, entered_at, replaces_id) VALUES
  ('res-a1', 'asha', 'rep-asha-aug', 'HbA1c', '6.8', NULL, 6.8, '%', '4.0 - 5.6', 'High', NULL, '2026-08-12', '2026-08-13T09:01:00Z', NULL),
  ('res-a2', 'asha', 'rep-asha-aug', 'Glucose', '118', NULL, 118, 'mg/dL', '70 - 99', 'High', 'Fasting', '2026-08-12', '2026-08-13T09:01:00Z', NULL),
  ('res-a3', 'asha', 'rep-asha-aug', 'CRP', '<5', '<', 5, 'mg/L', '<10', NULL, NULL, '2026-08-12', '2026-08-13T09:01:00Z', NULL),
  ('res-a4', 'asha', 'rep-asha-aug', 'TSH', '2.1', NULL, 2.1, 'mIU/L', '0.4 - 4.0', NULL, NULL, '2026-08-12', '2026-08-13T09:01:00Z', NULL),
  -- The lab corrected the TSH value: the amended result replaces the first one.
  ('res-a5', 'asha', 'rep-asha-sep', 'TSH', '4.6', NULL, 4.6, 'mIU/L', '0.4 - 4.0', 'High', NULL, '2026-08-12', '2026-09-02T18:31:00Z', 'res-a4'),
  ('res-a6', 'asha', 'rep-asha-sep', 'Free T4', '1.1', NULL, 1.1, 'ng/dL', '0.8 - 1.8', NULL, 'Direct', '2026-09-01', '2026-09-02T18:31:00Z', NULL),
  -- Typed in: only the month is known, and one with no date at all.
  ('res-a7', 'asha', NULL, 'Vitamin D', '22', NULL, 22, 'ng/mL', '30 - 100', 'Low', NULL, '2026-05', '2026-09-10T10:00:00Z', NULL),
  ('res-a8', 'asha', NULL, 'Blood group', 'B positive', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-09-10T10:05:00Z', NULL),
  ('res-r1', 'ravi', 'rep-ravi-jul', 'LDL cholesterol', '162', NULL, 162, 'mg/dL', '<100', 'High', 'Calculated', '2026-06-30', '2026-07-01T08:01:00Z', NULL),
  ('res-r2', 'ravi', 'rep-ravi-jul', 'HDL cholesterol', '41', NULL, 41, 'mg/dL', '>40', NULL, NULL, '2026-06-30', '2026-07-01T08:01:00Z', NULL);

-- Records from before Rufi kept their source (none given).
INSERT INTO medicine_uses (id, person_id, name, strength, amount, schedule, route, purpose, status, started, started_words) VALUES
  ('med-a1', 'asha', 'Metformin', '500 mg', '1 tablet', 'twice a day', 'by mouth', 'blood sugar', 'current', '2024-03', NULL),
  ('med-a2', 'asha', 'Creatine', '5 g', NULL, 'every morning', NULL, NULL, 'current', '2026-06', NULL),
  ('med-r1', 'ravi', 'Atorvastatin', '10 mg', '1 tablet', 'at night', 'by mouth', 'cholesterol', 'current', '2026-07', NULL);

INSERT INTO allergies (id, person_id, substance, reaction, status, certainty, asserted) VALUES
  ('all-r1', 'ravi', 'Penicillin', 'rash', 'active', 'confirmed', '2025-02-10');
