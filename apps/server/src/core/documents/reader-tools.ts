// The reader's two tools, bound by code to one run: one person, one
// document, the job's current attempt. They take only a page number (and,
// for save_page, the entry and note): never a person, a document, a path or
// a job. get_page shows a page and marks it looked at; save_page writes the
// page's entry through the notebook.
import { Schema } from "effect";
import type { Log } from "../../platform/logs.ts";
import {
  defineTool,
  inputSchema,
  Refusal,
  shownFor,
  toolCaller,
  WithImage,
  type Tool,
} from "../tools/registry.ts";
import { Entry, Note, type Notebook, type Run } from "./notebook.ts";
import type { Pages } from "./pages.ts";

const Page = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  description: "The page's number in this document: 1, 2, 3...",
});

/**
 * Wrong inputs a reading may make before Rufi stops it: more than a chat
 * turn's, as one reading saves many pages.
 */
const READER_REJECTIONS = 10;

function readerTools(run: Run, pages: Pages, book: Notebook): readonly Tool[] {
  const getPage = defineTool({
    name: "get_page",
    description:
      "Look at one page of the document you are reading: its image, the page's own text when the PDF has text (use it for exact characters), the entry you saved for it (if any), your note and which pages are saved. Look at a page before you save it, and again after your earlier context was summarised.",
    shown: "Looked at a page",
    input: Schema.Struct({ page: Page }),
    callers: "model",
    readOnly: true,
    destructive: false,
    examples: [{ page: 1 }],
    run: async ({ page }) => {
      if (run.closed) throw new Refusal("This reading has ended.");
      const view = await pages.page(run.personId, run.documentId, page);
      if (!view) {
        const count = await pages.count(run.personId, run.documentId);
        throw new Refusal(
          `This document has no page ${String(page)}; its pages are 1–${String(count)}.`,
        );
      }
      run.lookedAt.add(page);
      const about = {
        page,
        of: view.pages,
        file: view.fileName,
        ...(view.ok && view.text !== undefined && { text: view.text }),
        entry: await book.entry(run, page),
        ...(await book.progress(run)),
      };
      if (!view.ok) {
        return {
          ...about,
          image:
            "This page couldn't be prepared, so there is no image. Save it as unreadable, with why.",
        };
      }
      return new WithImage(about, view.image);
    },
  });

  const savePage = defineTool({
    name: "save_page",
    description:
      "Save a page's entry in your notebook: what the page says, with every result as printed. Saving a page again replaces its entry. `note` is your one note for the whole document; give it whole when it changes, or leave it out to keep it. Save every page you were asked to read, also an empty one.",
    shown: "Saved a page",
    input: Schema.Struct({
      page: Page,
      entry: Entry,
      note: Schema.optionalKey(Note),
    }),
    callers: "model",
    readOnly: false,
    destructive: false,
    examples: [
      {
        page: 1,
        entry: {
          outcome: "read",
          rows_seen: 1,
          items: [
            {
              test_name: "Haemoglobin",
              value_text: "13.2",
              value_number: 13.2,
              unit: "g/dL",
              reference_range: "12.0-15.0",
            },
          ],
        },
        note: "Collected date is on page 1.",
      },
    ],
    run: ({ page, entry, note }) => book.save(run, page, entry, note),
  });

  return [getPage, savePage];
}

/** The reader's tools as an agent takes them, and a caller for its turn. */
export function forReader(run: Run, pages: Pages, book: Notebook, log: Log) {
  const tools = readerTools(run, pages, book);
  return {
    namespace: "rufi",
    specs: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      shown: (input: unknown) => shownFor(tool, input),
      inputSchema: inputSchema(tool),
    })),
    call: toolCaller(
      tools,
      () => ({ store: undefined, personId: run.personId }),
      log,
      READER_REJECTIONS,
    ),
  };
}
