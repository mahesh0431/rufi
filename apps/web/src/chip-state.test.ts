import type { DocumentSummary, ReadingNow } from "@rufi/contracts/documents";
import { describe, expect, it } from "vitest";
import { chipState } from "./chip-state.ts";

const summary = (
  status: DocumentSummary["status"],
  canRetry = false,
): DocumentSummary => ({
  id: "doc-1",
  addedAt: "2026-10-11T09:00:00Z",
  kind: null,
  date: null,
  lab: null,
  place: null,
  sorting: null,
  status,
  reading:
    status === "not_read"
      ? null
      : {
          saved: 2,
          of: 2,
          results: 3,
          hasPending: true,
          toCheck: 0,
          itemsSaved: 0,
          itemsSetAside: 0,
          canRetry,
          error: null,
        },
  files: [],
});

const job = (state: ReadingNow["state"], saved = 0, of = 0): ReadingNow => ({
  documentId: "doc-1",
  name: "scan-oct.pdf",
  state,
  again: false,
  saved,
  of,
  runAt: null,
});

describe("a document chip's state, from the document and its reading job", () => {
  it.each([
    [
      "running, with its pages",
      summary("reading"),
      job("running", 2, 3),
      "Reading… 2 of 3 pages",
    ],
    [
      "running, with its one page",
      summary("reading"),
      job("running", 0, 1),
      "Reading… 0 of 1 page",
    ],
    [
      "running, before it knows its pages",
      summary("reading"),
      job("running"),
      "Reading…",
    ],
    [
      "waiting for its turn",
      summary("reading"),
      job("waiting"),
      "Waiting to read",
    ],
    [
      "a retry that waits, after a reading that ended",
      summary("done", true),
      job("waiting"),
      "Waiting to read",
    ],
    ["done", summary("done"), undefined, "Read"],
    [
      "done, with pages to read again",
      summary("done", true),
      undefined,
      "Read · some pages unclear",
    ],
    ["failed", summary("failed"), undefined, "Couldn't read"],
    ["never read, and no job", summary("not_read"), undefined, undefined],
    ["reading, but no job known yet", summary("reading"), undefined, undefined],
    ["not known yet", undefined, undefined, undefined],
  ] as const)("%s", (_, document, reading, shown) => {
    expect(chipState(document, reading)?.text).toBe(shown);
  });
});
