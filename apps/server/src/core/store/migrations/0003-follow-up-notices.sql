-- The notices Rufi gave for follow-ups (docs/adr/0012): for each one, the
-- due it was for and the last state told (due, then overdue). Operational
-- state, not the record: no save writes it and no history keeps it. Only
-- the notice claim (core/record/notices.ts) writes it.
CREATE TABLE follow_up_notices (
  person_id TEXT NOT NULL,
  follow_up_id TEXT NOT NULL,
  due TEXT NOT NULL,           -- the follow-up's due when the notice was given
  state TEXT NOT NULL CHECK (state IN ('due', 'overdue')),
  PRIMARY KEY (person_id, follow_up_id),
  FOREIGN KEY (person_id, follow_up_id) REFERENCES follow_ups (person_id, id)
) STRICT;
