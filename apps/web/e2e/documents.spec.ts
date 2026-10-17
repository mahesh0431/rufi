// The Documents page on the real core: adding files (photos as one document
// in the order chosen, a PDF on its own, the same content again, a file that
// isn't a document), a file Rufi AI split into documents, one it hasn't
// sorted yet and its Retry, and, from a document's page, the popup that
// shows the original. The strict CSP refuses nothing the page needs.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { Scenario } from "../../server/tests/fake-codex.ts";
import { readPage, scriptedReader } from "../../server/tests/fake-reader.ts";
import { expect, test, type Rufi } from "./rufi.ts";

const FIXTURES = join(
  import.meta.dirname,
  "../../server/tests/fixtures/documents",
);

async function accessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);
}

// The CSP's refusals, collected in the page.
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    const refused: string[] = [];
    Object.assign(globalThis, { refused });
    (globalThis as unknown as EventTarget).addEventListener(
      "securitypolicyviolation",
      (event) => {
        const { violatedDirective, blockedURI } = event as Event & {
          violatedDirective: string;
          blockedURI: string;
        };
        refused.push(`${violatedDirective} ${blockedURI}`);
      },
    );
  });
});
test.afterEach(async ({ page }) => {
  expect(
    await page.evaluate(
      () => (globalThis as unknown as { refused: string[] }).refused,
    ),
  ).toEqual([]);
});

/** A file for the picker, from the fixtures, under `name` and `mimeType`. */
const fixture = async (file: string, name = file, mimeType = "") => ({
  name,
  mimeType,
  buffer: await readFile(join(FIXTURES, file)),
});

/** Rufi with the family; `empty`: Asha has no documents yet. */
async function documentsPage(page: Page, rufi: Rufi, empty = false) {
  await rufi.family(
    ...(empty
      ? [
          `DELETE FROM record_sources; DELETE FROM results; DELETE FROM reports;
           DELETE FROM document_pages; DELETE FROM documents;`,
        ]
      : []),
  );
  await rufi.start();
  await page.goto(rufi.link());
  await page.getByRole("link", { name: "Documents" }).click();
  await expect(
    page.getByRole("heading", { name: "Documents", exact: true }),
  ).toBeVisible();
}

const picker = (page: Page) =>
  page.getByLabel("Choose documents", { exact: true });
const rows = (page: Page) =>
  page.getByRole("row").filter({ hasNot: page.getByRole("columnheader") });

test("adds photos as one document in the order chosen, and a PDF as its own", async ({
  page,
  rufi,
}) => {
  await documentsPage(page, rufi, true);
  await expect(page.getByText("No documents yet")).toBeVisible();
  await accessible(page);

  await picker(page).setInputFiles([
    // A photo by its content, though its name and type say PDF.
    await fixture("sideways.heic", "IMG_1.pdf", "application/pdf"),
    await fixture("thyroid-recheck.jpg", "IMG_2.jpg"),
    await fixture("ravi-lipid-panel.pdf", "lipid.pdf"),
  ]);
  const dialog = page.getByRole("dialog", { name: "Add 2 photos and 1 PDF" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("switch")).toBeChecked();
  await accessible(page);
  // The photo taken second becomes page 1.
  await dialog.getByRole("button", { name: "Move IMG_2.jpg" }).press("ArrowUp");
  await expect(dialog.getByRole("listitem")).toHaveText([
    /IMG_2\.jpg\s*page 1/,
    /IMG_1\.pdf\s*page 2/,
    /lipid\.pdf\s*own document/,
  ]);
  await dialog.getByRole("button", { name: "Add 2 documents" }).click();

  await expect(page.getByRole("status")).toHaveText("Added 2 documents.");
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).filter({ hasText: "IMG_2.jpg" })).toContainText(
    "+ 1 more photo",
  );
  await expect(rows(page).filter({ hasText: "lipid.pdf" })).toContainText(
    "1 page",
  );
  // Rufi reads what is added at once; no reader here, so it waits its turn.
  await expect(rows(page).first()).toContainText("Reading · read 0 of 1");

  // The popup: the photos in their order, the HEIC upright through its copy.
  await page.getByRole("link", { name: "IMG_2.jpg" }).click();
  await page.getByRole("button", { name: "View original" }).click();
  const popup = page.getByRole("dialog", { name: /IMG_2\.jpg/ });
  const second = popup.getByRole("img", { name: "Photo 2 of 2" });
  await expect(second).toBeVisible();
  expect(
    await second.evaluate((img: HTMLImageElement) => [
      img.naturalWidth,
      img.naturalHeight,
    ]),
  ).toEqual([100, 200]);
  await accessible(page);
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
});

test("names the same content again, also renamed, and refuses a file that isn't a document", async ({
  page,
  rufi,
}) => {
  await documentsPage(page, rufi);
  await expect(rows(page)).toHaveCount(2);

  await picker(page).setInputFiles([
    await fixture("thyroid-recheck.jpg", "copy of thyroid.jpg"),
  ]);
  const status = page.getByRole("status");
  await expect(status).toHaveText(
    "copy of thyroid.jpg was already added: open it.",
  );
  await expect(rows(page)).toHaveCount(2);
  await status.getByRole("button", { name: "open it" }).click();
  await expect(
    page.getByRole("heading", { name: /thyroid recheck\.jpg/ }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Documents" }).click();

  await picker(page).setInputFiles([
    {
      name: "notes.docx",
      mimeType: "",
      buffer: Buffer.from("Fictional notes"),
    },
  ]);
  await expect(page.getByRole("alert")).toHaveText(
    "notes.docx isn't a PDF, JPEG, PNG or HEIC photo. Nothing was added. Remove it and add the others again.",
  );
  await expect(rows(page)).toHaveCount(2);
});

test("offers a copy of a PDF where the browser has no PDF viewer", async ({
  page,
  rufi,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await documentsPage(page, rufi);
  await accessible(page);
  await page.getByRole("link", { name: "Sunrise Labs August.pdf" }).click();
  await page.getByRole("button", { name: "View original" }).click();
  const popup = page.getByRole("dialog", { name: /Sunrise Labs August\.pdf/ });
  await expect(popup).toContainText("PDF · 2 pages");
  // Chromium here has no PDF viewer: the Rufi app's has (apps/desktop/e2e).
  expect(await page.evaluate(() => navigator.pdfViewerEnabled)).toBe(false);
  const copy = popup.getByRole("link", { name: "Save a copy" });
  await expect(copy).toHaveAttribute("href", /^blob:/);
  await expect(copy).toHaveAttribute("download", "Sunrise Labs August.pdf");
  await accessible(page);
});

test("keeps each date on one line in windows 800 to 1024 wide", async ({
  page,
  rufi,
}) => {
  await rufi.family(
    `UPDATE documents SET kind = 'lab_report', date = '2026-08-12'
     WHERE id = 'doc-asha-aug';
     UPDATE documents SET kind = 'prescription', date = '2026-09'
     WHERE id = 'doc-asha-sep';`,
  );
  await rufi.start();
  await page.goto(rufi.link());
  await page.getByRole("link", { name: "Documents" }).click();
  await expect(rows(page)).toHaveCount(2);
  // The Date and Added columns' cells, newest first; the day added is
  // this Mac's.
  const dates = rows(page).locator("td:nth-child(3), td:nth-child(4)");
  await expect(dates).toHaveText([
    "Sep 2026",
    /^\d Sep 2026$/,
    "12 Aug 2026",
    /^1\d Aug 2026$/,
  ]);
  for (const width of [800, 900, 1024]) {
    await page.setViewportSize({ width, height: 720 });
    const lines = await dates.evaluateAll((cells) =>
      cells.map((cell) => {
        const range = document.createRange();
        range.selectNodeContents(cell);
        // One box per line the text takes.
        return new Set([...range.getClientRects()].map((r) => r.top)).size;
      }),
    );
    expect(lines, `at ${String(width)} px`).toEqual([1, 1, 1, 1]);
    // And every column fits: no sideways scroll.
    const table = page.getByRole("table");
    expect(
      await table.evaluate(
        (element) =>
          element.scrollWidth <= (element.parentElement?.clientWidth ?? 0),
      ),
      `at ${String(width)} px`,
    ).toBe(true);
  }
});

/** The scripted reader's copies of both pages of the August report. */
const copied = () =>
  scriptedReader([
    async (turn) => {
      for (const page of [1, 2]) {
        await turn.look(page);
        await turn.save(page, readPage());
      }
      return undefined;
    },
  ]);

/** Rufi AI's sort of the file: a report on page 1, a prescription on page 2. */
const SPLIT = {
  tool: "sort_documents",
  arguments: {
    document: "$document",
    documents: [
      {
        pages: [1],
        kind: "lab_report",
        date: "2026-08-12",
        lab: "Sunrise Labs",
      },
      { pages: [2], kind: "prescription", date: "2026-08-12" },
    ],
    drafts: [
      {
        page: 1,
        test_name: "Haemoglobin",
        value_text: "13.2",
        unit: "g/dL",
        quote: "Haemoglobin | 13.2 | g/dL",
      },
    ],
  },
};

async function addReport(page: Page, rufi: Rufi, scenario: Scenario) {
  await rufi.family(
    `DELETE FROM record_sources; DELETE FROM results; DELETE FROM reports;
     DELETE FROM document_pages; DELETE FROM documents;`,
  );
  await rufi.start({
    reader: copied().run,
    scenario,
  });
  await page.goto(rufi.link());
  await page.getByRole("link", { name: "Documents" }).click();
  await page.getByLabel("Choose documents", { exact: true }).setInputFiles({
    name: "sunrise-labs-august.pdf",
    mimeType: "application/pdf",
    buffer: await readFile(join(FIXTURES, "sunrise-labs-august.pdf")),
  });
}

test("shows each document Rufi AI split from a file with its place in the file, kind, lab and date", async ({
  page,
  rufi,
}) => {
  await addReport(page, rufi, {
    callsByTurn: [[{ id: "sort-split", ...SPLIT }]],
  });
  const rows = page
    .getByRole("row")
    .filter({ hasText: "sunrise-labs-august.pdf" });
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("page 1 of 2");
  await expect(rows.nth(0)).toContainText("Lab report");
  await expect(rows.nth(0)).toContainText("Not saved · 1 result");
  await expect(rows.nth(1)).toContainText("page 2 of 2");
  await expect(rows.nth(1)).toContainText("Prescription");
  await accessible(page);

  await rows
    .nth(0)
    .getByRole("link", { name: "sunrise-labs-august.pdf" })
    .click();
  await expect(page.getByRole("heading", { level: 2 }).first()).toHaveText(
    /^sunrise-labs-august\.pdf · Lab report · page 1 of 2 · Sunrise Labs · 12 Aug 2026 · added /,
  );
  const items = page.getByRole("region", { name: "Items" });
  await expect(items).toContainText(
    "From the page: “Haemoglobin | 13.2 | g/dL”",
  );
  // Its page in the add, and where that is in the file.
  await expect(
    page.getByRole("region", { name: "Page" }).getByRole("img", {
      name: "Page 1 of 1",
    }),
  ).toBeVisible();
});

test("says a file Rufi AI hasn't sorted yet, and why; its Retry sorts it", async ({
  page,
  rufi,
}) => {
  // Rufi AI's first turn answers without sorting; the next one sorts.
  await addReport(page, rufi, {
    callsByTurn: [[], [{ id: "sort-again", ...SPLIT }]],
  });
  const row = page
    .getByRole("row")
    .filter({ hasText: "sunrise-labs-august.pdf" });
  const status = row.getByText("Not sorted yet");
  await expect(status).toBeVisible({ timeout: 10_000 });
  await expect(status).toHaveAttribute(
    "title",
    "Rufi AI asked you about it in the chat",
  );
  // It can't be added to a message until it is sorted.
  await row.hover();
  await expect(row.getByRole("button", { name: "Ask Rufi" })).toHaveCount(0);
  await accessible(page);

  await row.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "page 2 of 2" }),
  ).toContainText("Prescription");
});
