-- What a turn used, across all its requests, as its provider counted it
-- once it ended (JSON): the input tokens (all of them, and of those, how
-- many came from the cache), the tokens written, and the provider's own
-- count as reported. Null when the provider said nothing.
ALTER TABLE turns ADD COLUMN used TEXT;
