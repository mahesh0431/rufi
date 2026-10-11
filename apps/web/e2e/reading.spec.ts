// Reading documents on the screens, on the real core with a scripted reader
// (tests/fake-reader.ts): reading as a document is added, with the model and
// effort chosen in Settings, the reader strip above the chat box, a chip's
// state in the box, the start and end lines, and Open with the reader's
// work and the document's page.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { readPage, scriptedReader } from "../../server/tests/fake-reader.ts";
import { expect, test, type Rufi } from "./rufi.ts";

const REPORT = join(
  import.meta.dirname,
  "../../server/tests/fixtures/documents/sunrise-labs-august.pdf",
);

async function accessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);
}

/** Rufi with the family and no documents, reading with `reader`. */
async function opened(
  page: Page,
  rufi: Rufi,
  reader: ReturnType<typeof scriptedReader>,
) {
  await rufi.family(
    `DELETE FROM record_sources; DELETE FROM results; DELETE FROM reports;
     DELETE FROM document_pages; DELETE FROM documents;`,
  );
  await rufi.start({ reader: reader.run });
  await page.goto(rufi.link());
}

/** As `opened`, with the fictional report just added. */
async function start(
  page: Page,
  rufi: Rufi,
  reader: ReturnType<typeof scriptedReader>,
) {
  await opened(page, rufi, reader);
  await add(page);
}

/** Adds the fictional report on the Documents page. */
async function add(page: Page) {
  await page.getByRole("link", { name: "Documents" }).click();
  await page.getByLabel("Choose documents", { exact: true }).setInputFiles({
    name: "sunrise-labs-august.pdf",
    mimeType: "application/pdf",
    buffer: await readFile(REPORT),
  });
}

test("reads a report in the background as it is added: the strip, the lines and Open", async ({
  page,
  rufi,
}) => {
  const gate = Promise.withResolvers<undefined>();
  const reader = scriptedReader([
    async (turn) => {
      await turn.look(1);
      await turn.save(1, readPage(), "Collected date on page 1.");
      await gate.promise;
      await turn.look(2);
      await turn.save(2, readPage());
      return undefined;
    },
  ]);
  await start(page, rufi, reader);

  await expect(
    page.getByRole("cell", { name: /Reading · read 1 of 2/ }),
  ).toBeVisible();
  await accessible(page);
  // Its chip in the chat box says what Rufi is doing with it.
  const row = page
    .getByRole("row")
    .filter({ hasText: "sunrise-labs-august.pdf" });
  await row.hover();
  await row.getByRole("button", { name: "Ask Rufi" }).click();
  const chip = page
    .getByRole("list", { name: "Added to this message" })
    .getByRole("listitem");

  await page.getByRole("link", { name: "Chat with Rufi" }).click();
  await expect(chip).toHaveText(
    "sunrise-labs-august.pdf · Reading… 1 of 2 pages",
  );
  await expect(
    page.getByText("Reading sunrise-labs-august.pdf · 2 pages"),
  ).toBeVisible();
  const strip = page.getByRole("region", { name: "Reading documents" });
  await expect(strip).toContainText("sunrise-labs-august.pdf");
  await expect(strip).toContainText("read 1 of 2");
  await strip.getByRole("button", { name: "Open ▸" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("reading · read 1 of 2");
  await expect(sheet).toContainText("Collected date on page 1.");
  await expect(sheet.getByRole("cell", { name: "Haemoglobin" })).toBeVisible();
  await expect(sheet).toContainText("Page 2");
  await accessible(page);
  await sheet.getByRole("button", { name: "Close" }).click();

  gate.resolve(undefined);
  const end = page.getByText("Lab report · 12 Aug · 2 results read");
  await expect(end).toBeVisible();
  await expect(strip).toBeHidden();
  await expect(chip).toHaveText("sunrise-labs-august.pdf · Read");
  // Open leads to the document's page; the reader's work is a button there.
  await page.getByRole("link", { name: "Open", exact: true }).click();
  await expect(page.getByRole("region", { name: "Items" })).toContainText(
    "2 results · 0 unsure",
  );
  await page.getByRole("button", { name: "The reader's work" }).click();
  await expect(sheet).toContainText("sunrise-labs-august.pdf · read");
  // Page 1 open, page 2 folded: both read.
  await expect(sheet.getByText(/^read · 1 item · Sunrise Labs/)).toHaveCount(2);
});

test("Settings keeps the reader's model and effort, and the next reading runs with them", async ({
  page,
  rufi,
}) => {
  const reader = scriptedReader([
    async (turn) => {
      await turn.look(1);
      await turn.save(1, readPage());
      await turn.look(2);
      await turn.save(2, readPage());
      return undefined;
    },
  ]);
  await opened(page, rufi, reader);
  await page.getByRole("link", { name: "Settings" }).click();
  const model = page.getByRole("combobox", { name: "Reader model" });
  await expect(model).toHaveValue("gpt-6.1-sol");
  await expect(model.getByRole("option")).toHaveText([
    "GPT-6.1-Sol",
    "GPT-5.5",
  ]);
  const effort = page.getByRole("radiogroup", { name: "Effort" });
  await expect(effort.getByRole("radio", { name: "Medium" })).toBeChecked();
  await accessible(page);
  await model.selectOption("gpt-5.5");
  await effort.getByRole("radio", { name: "High" }).click();
  await expect(effort.getByRole("radio", { name: "High" })).toBeChecked();
  await page.reload();
  await expect(model).toHaveValue("gpt-5.5");
  await expect(effort.getByRole("radio", { name: "High" })).toBeChecked();

  await add(page);
  await expect(
    page.getByRole("cell", { name: /To check · 2 results/ }),
  ).toBeVisible({ timeout: 10_000 });
  expect(reader.runs.map(({ model, effort }) => ({ model, effort }))).toEqual([
    { model: "gpt-5.5", effort: "high" },
  ]);
});

test("keeps unreadable pages to check and reserves Nothing to save for a completed empty reading", async ({
  page,
  rufi,
}) => {
  const reader = scriptedReader([
    async (turn) => {
      await turn.look(1);
      await turn.save(1, {
        outcome: "unreadable",
        why: "The print is blurred.",
        items: [],
      });
      await turn.look(2);
      await turn.save(2, { outcome: "nothing_here", items: [] });
      return undefined;
    },
    async (turn) => {
      await turn.look(1);
      await turn.save(1, {
        outcome: "read",
        facts: { kind: "letter" },
        items: [],
      });
      return undefined;
    },
  ]);
  await start(page, rufi, reader);
  const status = page
    .getByRole("row", { name: /sunrise-labs-august.pdf/ })
    .getByRole("cell")
    .nth(4); // Status
  await expect(status).toContainText("To check");
  await expect(status).not.toContainText("Nothing to save");
  await status.getByRole("button", { name: "Retry" }).click();
  await expect(status).toContainText("Nothing to save");
  await expect(status.getByRole("button", { name: "Retry" })).toBeHidden();
});
