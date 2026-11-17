-- A question card's answers carry more than their words: each is an object
-- with its label, and, when Rufi AI gives them, a short description and
-- whether it recommends it. A card asked before keeps its answers, each as
-- its label, in order.
UPDATE transcript_entries
SET card = json_set(
  card,
  '$.answers',
  json((
    SELECT json_group_array(json_object('label', value))
    FROM (SELECT value FROM json_each(transcript_entries.card, '$.answers') ORDER BY key)
  ))
)
WHERE kind = 'question'
  AND json_type(card, '$.answers') = 'array'
  AND EXISTS (SELECT 1 FROM json_each(transcript_entries.card, '$.answers') WHERE type = 'text');
