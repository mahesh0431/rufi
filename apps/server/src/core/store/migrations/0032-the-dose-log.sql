-- The dose log (docs/adr/0033): what the person said happened to a dose of
-- a medicine: taken, skipped, or a log cleared (an undo). Kept as it came,
-- outside the record: no save writes it, and a row never changes or goes.
-- The id is made where it was logged and kept across a retry. A dose's
-- state is its row with the latest logged_at, then received_at.
CREATE TABLE dose_log (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  medicine_use_id TEXT NOT NULL,
  dose_at TEXT NOT NULL,       -- the dose: local 'YYYY-MM-DDTHH:MM', its date and time as rung or shown
  state TEXT NOT NULL CHECK (state IN ('taken', 'skipped', 'cleared')),
  taken_at TEXT,               -- when taken, when said and not the moment it was logged (UTC)
  logged_at TEXT NOT NULL,     -- when the person logged it, on the device they used (UTC)
  received_at TEXT NOT NULL,   -- when Rufi stored it (UTC)
  logged_by TEXT NOT NULL,     -- 'mac', 'rufi_ai' or 'app:<paired app id>'
  FOREIGN KEY (person_id, medicine_use_id) REFERENCES medicine_uses (person_id, id)
) STRICT;
CREATE INDEX dose_log_by_dose ON dose_log (person_id, dose_at);
