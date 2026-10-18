-- The reader's copy of a page: the page as Markdown, exactly as printed,
-- marks for what was unclear included. One per page of a file and reading
-- (a reading's runs replace it until the reading ends; a new reading of the
-- page adds its own), so a copy is known by its file page and its reading,
-- never by the document the page is in now. A new table: nothing before it
-- changes.
CREATE TABLE page_copies (
  person_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  page_in_file INTEGER NOT NULL,
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('read', 'nothing_here', 'unreadable')),
  copy TEXT NOT NULL,
  why TEXT,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (person_id, file_id, page_in_file, job_id),
  FOREIGN KEY (person_id, file_id, page_in_file) REFERENCES document_pages (person_id, file_id, page_in_file),
  FOREIGN KEY (person_id, job_id) REFERENCES jobs (person_id, id)
) STRICT;

CREATE INDEX page_copies_by_job ON page_copies (person_id, job_id);
