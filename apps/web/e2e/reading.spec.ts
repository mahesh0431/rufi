// Reading documents on the screens, on the real core with a scripted reader
// (tests/fake-reader.ts): the one-time yes, the reader strip above the chat
// box, the start and end lines, and Open with the reader's work and the
// document's page.
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
async function start(
  page: Page,
  rufi: Rufi,
  reader: ReturnType<typeof scriptedReader>,
) {
  await rufi.family(
    `DELETE FROM results; DELETE FROM reports;
     DELETE FROM document_pages; DELETE FROM documents;`,
  );
  await rufi.start({ reader: reader.run });
  await page.goto(rufi.link());
  await page.getByRole("link", { name: "Documents" }).click();
  await page.getByLabel("Choose documents").setInputFiles({
    name: "sunrise-labs-august.pdf",
    mimeType: "application/pdf",
    buffer: await readFile(REPORT),
  });
}

test("asks once, then reads a report in the background: the strip, the lines and Open", async ({
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

  const card = page.getByRole("region", { name: "Read documents with the AI" });
  await expect(card).toContainText("Read sunrise-labs-august.pdf with the AI?");
  await expect(page.getByRole("cell", { name: /Not read yet/ })).toBeVisible();
  await accessible(page);
  await card.getByRole("button", { name: "Read it" }).click();
  await expect(card).toBeHidden();
  await expect(
    page.getByRole("cell", { name: /Reading · saved 1 of 2/ }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Chat with Rufi" }).click();
  await expect(
    page.getByText("Reading sunrise-labs-august.pdf · 2 pages"),
  ).toBeVisible();
  const strip = page.getByRole("region", { name: "Reading documents" });
  await expect(strip).toContainText("sunrise-labs-august.pdf");
  await expect(strip).toContainText("saved 1 of 2");
  await strip.getByRole("button", { name: "Open ▸" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("reading · saved 1 of 2");
  await expect(sheet).toContainText("Collected date on page 1.");
  await expect(sheet.getByRole("cell", { name: "Haemoglobin" })).toBeVisible();
  await expect(sheet).toContainText("Page 2");
  await accessible(page);
  await sheet.getByRole("button", { name: "Close" }).click();

  gate.resolve(undefined);
  const end = page.getByText("Lab report · 12 Aug · 2 results read");
  await expect(end).toBeVisible();
  await expect(strip).toBeHidden();
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

test("Not now keeps the document not read; its Read it asks again", async ({
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
  await start(page, rufi, reader);
  const card = page.getByRole("region", { name: "Read documents with the AI" });
  await card.getByRole("button", { name: "Not now" }).click();
  await expect(card).toBeHidden();
  await expect(page.getByRole("cell", { name: /Not read yet/ })).toBeVisible();
  expect(reader.runs).toEqual([]);

  await page.getByRole("button", { name: "Read it" }).click();
  const ask = page.getByRole("dialog");
  await expect(ask).toContainText("Read sunrise-labs-august.pdf with the AI?");
  await ask.getByRole("button", { name: "Read it" }).click();
  await expect(
    page.getByRole("cell", { name: /To check · 2 results/ }),
  ).toBeVisible({
    timeout: 10_000,
  });

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("switch")).toBeChecked();
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
  await page
    .getByRole("region", { name: "Read documents with the AI" })
    .getByRole("button", { name: "Read it" })
    .click();
  const status = page
    .getByRole("row", { name: /sunrise-labs-august.pdf/ })
    .getByRole("cell")
    .last();
  await expect(status).toContainText("To check");
  await expect(status).not.toContainText("Nothing to save");
  await status.getByRole("button", { name: "Retry" }).click();
  await expect(status).toContainText("Nothing to save");
  await expect(status.getByRole("button", { name: "Retry" })).toBeHidden();
});
