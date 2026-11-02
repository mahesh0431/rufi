-- Each person's reminder setting (docs/adr/0012, amended): what a medicine
-- reminder shows (the time, how many, or which ones) and where it rings
-- (their iPhone, the Mac, or both). A setting, not the record: no save or
-- history. Null is the default: How many, on the Mac, until they choose.
-- Where it rings counts only while an iPhone is paired for the person;
-- pairing or unpairing one writes nothing here.
CREATE TABLE reminder_settings (
  person_id TEXT PRIMARY KEY REFERENCES people (id),
  show TEXT CHECK (show IN ('time', 'count', 'names')),
  ring TEXT CHECK (ring IN ('iphone', 'mac', 'both'))
) STRICT;
