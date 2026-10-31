// Reading documents on the screens, on the real core with the scripted
// Codex: files wait in the chat box until Send; then Rufi AI has each read
// by a reader it starts (tests/readers.ts), whose line shows in its reply's
// Activity, and the reader's result wakes it to sort the file and answer.
// View reading shows the reader's copies. Retry on the Documents page puts
// a read again chip in the box, and Send has the pages that couldn't be read
// read again. A file message waiting when a backup is made waits held after
// a restore.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { Scenario } from "../../server/tests/fake-codex.ts";
import { readOf, readThen } from "../../server/tests/readers.ts";
import { backupsPath, makeBackup } from "../../server/src/core/store/backup.ts";
import { restore } from "../../server/src/core/store/restore.ts";
import { expect, FILE_WORK_MS, Rufi, sendFiles, test } from "./rufi.ts";

// Wide enough for the Documents page beside the chat panel.
test.use({ viewport: { width: 2000, height: 800 } });

const REPORT = join(
  import.meta.dirname,
  "../../server/tests/fixtures/documents/sunrise-labs-august.pdf",
);

async function accessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);
}

/** Rufi AI's sort of the report, once it is read: one draft a page. */
const SORT: NonNullable<Scenario["calls"]> = [
  {
    id: "sort-report",
    tool: "sort_documents",
    arguments: {
      document: "$document",
      documents: [
        {
          id: "$document",
          pages: [1, 2],
          kind: "lab_report",
          date: "2026-08-12",
        },
      ],
      drafts: [1, 2].map((page) => ({
        page,
        reading: "$reading",
        test_name: "Haemoglobin",
        value_text: "13.2",
        unit: "g/dL",
        quote: "Haemoglobin | 13.2 | g/dL",
      })),
    },
  },
];

/** Rufi with the family and no documents, the scripted Codex playing `scenario`. */
async function opened(page: Page, rufi: Rufi, scenario: Scenario) {
  await rufi.family(
    `DELETE FROM record_sources; DELETE FROM results; DELETE FROM reports;
     DELETE FROM document_pages; DELETE FROM documents;`,
  );
  await rufi.start({ scenario });
  await page.goto(rufi.link());
  await page.getByRole("link", { name: "Documents" }).click();
}

/** The fictional report, as the picker gives it. */
async function report() {
  return {
    name: "sunrise-labs-august.pdf",
    mimeType: "application/pdf",
    buffer: await readFile(REPORT),
  };
}

const chat = (page: Page) => page.getByRole("region", { name: "Chat" });
const log = (page: Page) => chat(page).getByRole("log", { name: "Messages" });
/** The chips in the box (a sent message shows its own). */
const chips = (page: Page) =>
  chat(page)
    .locator("form")
    .getByRole("list", { name: "Added to this message" })
    .getByRole("listitem");
/** The replies' Activity buttons, oldest first. */
const activity = (page: Page) =>
  log(page).getByRole("button", { name: /^Activity · / });
/** A click outside the chat panel steps back to the bar: open it again. */
const reopen = (page: Page) =>
  chat(page)
    .getByRole("button", { name: /^Open the chat/ })
    .click();
const row = (page: Page) =>
  page.getByRole("row").filter({ hasText: "sunrise-labs-august.pdf" });

test("a file waits in the box until Send; then Rufi AI has a reader read it, a line in its reply; the reader's result wakes Rufi AI, which sorts it and answers; View reading shows the copies", async ({
  page,
  rufi,
}) => {
  await opened(page, rufi, {
    callsByText: readThen(
      "What is my haemoglobin?",
      [readOf(1), readOf(2)],
      SORT,
    ),
  });
  await page
    .getByLabel("Choose documents", { exact: true })
    .setInputFiles(await report());

  // In the box by its name, and nowhere else: not listed, not read.
  await expect(chips(page)).toHaveText(["sunrise-labs-august.pdf"]);
  await expect(page.getByText("No documents yet")).toBeVisible();
  await accessible(page);

  await chat(page)
    .getByRole("textbox", { name: "Message to Rufi" })
    .fill("What is my haemoglobin?");
  await chat(page).getByRole("button", { name: "Send" }).click();

  // The reply starts the reader and ends; the reader's result wakes Rufi
  // AI, which sorts the file and answers again.
  await expect(log(page)).toContainText("What is my haemoglobin?");
  await expect(log(page).locator(".reply")).toHaveCount(2, {
    timeout: FILE_WORK_MS,
  });
  await expect(row(page)).toContainText("Not saved · 2 results");
  await activity(page).first().click();
  await expect(
    log(page).getByRole("button", { name: /^Reading · / }),
  ).toHaveText(/^Reading · done · ok:Reading: read/);
  await activity(page).last().click();
  await expect(
    log(page).getByRole("list", { name: "Activity" }).last(),
  ).toContainText("rufi.sort_documents");
  await accessible(page);

  // The document's page has the reader's copies, both pages.
  await row(page)
    .getByRole("link", { name: "sunrise-labs-august.pdf" })
    .click();
  await expect(page.getByRole("region", { name: "Items" })).toContainText(
    "2 results · 0 worth a look",
  );
  await page.getByRole("button", { name: "View reading" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("sunrise-labs-august.pdf · read");
  await expect(sheet.locator("pre")).toHaveCount(2);
  await expect(sheet.locator("pre").nth(1)).toContainText("| Haemoglobin |");
  await accessible(page);
});

test("a file shows Reading, with no Retry, while the reader Rufi AI set on it works", async ({
  page,
  rufi,
}) => {
  // Rufi AI starts a reader and sets it on the file; the reader works on.
  await opened(page, rufi, {
    callsByText: {
      "Read it": [
        {
          id: "start-reader",
          tool: "start_agent",
          arguments: {
            title: "Reading",
            task: "hang: read (document $document) with the reading-documents skill.",
          },
        },
        {
          id: "set-reader",
          tool: "set_reader",
          arguments: { documents: ["$document"], agent: "$started" },
        },
      ],
    },
  });
  await sendFiles(page, await report(), "Read it");
  await expect(row(page)).toContainText("Reading", { timeout: FILE_WORK_MS });
  await expect(row(page).getByRole("button", { name: "Retry" })).toHaveCount(0);
  await accessible(page);
});

test("keeps unreadable pages to check, and Nothing to save for a reading with nothing to save; Retry puts the file in the box, and Send has Rufi AI read only the page that couldn't be read", async ({
  page,
  rufi,
}) => {
  // Rufi AI sorts each reading: nothing to draft either time. The page
  // read again joins its document as it is.
  const sort = (id: string, pages: number[], kind?: string) => [
    {
      id,
      tool: "sort_documents",
      arguments: {
        document: "$document",
        documents: [
          { id: "$document", pages, ...(kind !== undefined && { kind }) },
        ],
        drafts: [],
      },
    },
  ];
  await opened(page, rufi, {
    callsByText: {
      ...readThen(
        "Read it",
        [
          {
            page: 1,
            outcome: "unreadable",
            why: "The print is blurred.",
            copy: "",
          },
          { page: 2, outcome: "nothing_here", copy: "" },
        ],
        sort("sort-first", [1, 2], "other"),
      ),
      ...readThen(
        "Once more",
        [
          {
            page: 1,
            outcome: "read",
            copy: "Dear Asha,\n\nYour results were normal.",
          },
        ],
        sort("sort-again", [1]),
        "Reading again",
      ),
    },
  });
  await sendFiles(page, await report(), "Read it");
  const status = row(page).getByRole("cell").nth(4); // Status
  await expect(status).toContainText("To check", { timeout: FILE_WORK_MS });
  await expect(status).not.toContainText("Nothing to save");
  // Both replies ended: the next message starts a reply of its own.
  await expect(log(page).locator(".reply")).toHaveCount(2);

  // Retry puts the file in the box; only Send has it read.
  await status.getByRole("button", { name: "Retry" }).click();
  await expect(chips(page)).toHaveText([
    "sunrise-labs-august.pdf · read again",
  ]);
  await chat(page)
    .getByRole("textbox", { name: "Message to Rufi" })
    .fill("Once more");
  await expect(status).toContainText("To check");
  await chat(page).getByRole("button", { name: "Send" }).click();
  await expect(status).toContainText("Nothing to save", {
    timeout: FILE_WORK_MS,
  });
  await expect(status.getByRole("button", { name: "Retry" })).toBeHidden();
  // Rufi's note named only the page that couldn't be read.
  expect(await rufi.given("Once more")).toMatch(
    /\(document [^)]+\): pages 1 of 2 again, which couldn't be read/,
  );
});

test("a file message waiting when a backup is made waits held after a restore, with Send and Remove: Send has its file read and sorted, Remove leaves the file not read", async ({
  page,
  rufi,
}) => {
  const scenario: Scenario = {
    callsByText: readThen("Sort this please", [readOf(1), readOf(2)], SORT),
  };
  await opened(page, rufi, scenario);
  // A reply runs, and the file message is queued behind it.
  await reopen(page);
  const box = chat(page).getByRole("textbox", { name: "Message to Rufi" });
  await box.fill("hang on");
  await chat(page).getByRole("button", { name: "Send" }).click();
  await expect(chat(page).getByRole("button", { name: "Stop" })).toBeVisible();
  await page
    .getByLabel("Choose documents", { exact: true })
    .setInputFiles(await report());
  await expect(chips(page)).toHaveText(["sunrise-labs-august.pdf"], {
    timeout: FILE_WORK_MS,
  });
  await box.fill("Sort this please");
  await chat(page).getByRole("button", { name: "Queue" }).click();
  await expect(
    chat(page).getByRole("region", { name: "Waiting messages" }),
  ).toContainText("Sort this please");
  const backup = await makeBackup(rufi.home, new Date());

  // Restored, the message waits held from the backup, with Send and Remove.
  for (const action of ["Remove", "Send"] as const) {
    const target = await mkdtemp(join(tmpdir(), "rufi-restored-"));
    const restored = new Rufi(target);
    try {
      await restore(join(backupsPath(rufi.home), backup.name), target);
      await restored.start({ scenario });
      await page.goto(restored.link());
      await page.getByRole("link", { name: "Documents" }).click();
      await reopen(page);
      const waiting = chat(page).getByRole("region", {
        name: "Waiting messages",
      });
      await expect(waiting).toContainText("Sort this please");
      await expect(waiting).toContainText("From a backup");
      await expect(
        waiting.getByRole("button", { name: "Send", exact: true }),
      ).toBeVisible();
      await expect(
        waiting.getByRole("button", { name: "Remove" }),
      ).toBeVisible();
      await waiting.getByRole("button", { name: action, exact: true }).click();
      await expect(waiting).toHaveCount(0);
      // Sent, Rufi AI has the file read and sorts it; removed, the file
      // stays sent and not read.
      await expect(row(page)).toContainText(
        action === "Send" ? "Not saved · 2 results" : "Not read yet",
        { timeout: FILE_WORK_MS },
      );
    } finally {
      await restored.close();
      await rm(target, { recursive: true, force: true });
    }
  }
});
