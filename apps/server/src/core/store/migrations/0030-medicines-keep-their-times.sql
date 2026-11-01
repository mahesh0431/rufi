-- A medicine keeps its directions as printed or said, and beside them the
-- timing Rufi can use (docs/adr/0031): the local times of day it is taken,
-- which days (an RFC 5545 rule; none: every day), until when (the last
-- dose, at its precision) and whether Rufi reminds the person at its
-- times. `schedule` becomes `directions`, its values kept, and so does the
-- key in history, so the reverse of an older change gives a field that is
-- there. Receipts and stored requests stay as written.
ALTER TABLE medicine_uses RENAME COLUMN schedule TO directions;
UPDATE record_changes
  SET before = json_remove(json_set(before, '$.directions', json_extract(before, '$.schedule')), '$.schedule')
  WHERE kind = 'medicine_use' AND json_type(before, '$.schedule') IS NOT NULL;
UPDATE record_changes
  SET after = json_remove(json_set(after, '$.directions', json_extract(after, '$.schedule')), '$.schedule')
  WHERE kind = 'medicine_use' AND json_type(after, '$.schedule') IS NOT NULL;
ALTER TABLE medicine_uses ADD COLUMN times TEXT CHECK (times IS NULL OR json_valid(times));
ALTER TABLE medicine_uses ADD COLUMN days TEXT;
ALTER TABLE medicine_uses ADD COLUMN until TEXT;
ALTER TABLE medicine_uses ADD COLUMN until_words TEXT;
ALTER TABLE medicine_uses ADD COLUMN remind INTEGER NOT NULL DEFAULT 0 CHECK (remind IN (0, 1));
-- The reminders Rufi handled for medicines (docs/adr/0012, 0031): for each,
-- the latest dose the notice claim told or passed over. Operational state,
-- like follow_up_notices: no save writes it and no history keeps it.
CREATE TABLE medicine_notices (
  person_id TEXT NOT NULL,
  medicine_use_id TEXT NOT NULL,
  told TEXT NOT NULL,          -- the latest dose handled, local 'YYYY-MM-DDTHH:MM'
  PRIMARY KEY (person_id, medicine_use_id),
  FOREIGN KEY (person_id, medicine_use_id) REFERENCES medicine_uses (person_id, id)
) STRICT;
