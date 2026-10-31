-- What a sending agent said, in its own words, without the line the package
-- or the host puts around them for the agent that gets it: its answer and
-- its questions with their options, the text it wrote, or why its turn
-- failed; empty when it stopped. Null for the host's own inputs. The host
-- shows it as the agent's message.
ALTER TABLE queue ADD COLUMN said TEXT;
