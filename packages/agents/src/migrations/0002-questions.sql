-- The questions a turn asked, kept apart from the item they came with: a
-- question on an answer's or a note's item never overwrites it, and an item
-- may ask several. Items no longer take the type 'question'.
CREATE TABLE questions (
  turn_id TEXT NOT NULL REFERENCES turns (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,         -- the provider's item it came with
  number INTEGER NOT NULL,       -- its order among that item's questions: 1, 2...
  title TEXT NOT NULL,
  options TEXT NOT NULL,         -- the options (JSON array of strings), as the provider gave them
  created_at TEXT NOT NULL,
  PRIMARY KEY (turn_id, item_id, number)
) STRICT;
