// The Documents page on the real core: Add opens the chat and the picker
// (photos as one document in the order chosen, a PDF on its own, a file that
// isn't a document), and a sent file is listed; a file Rufi AI split into
// documents, one it hasn't sorted yet and Ask Rufi, and, from a document's
// page, the popup that shows the original. The strict CSP refuses nothing the
// page needs.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { Scenario } from "../../server/tests/fake-codex.ts";
import {
  readPage,
  scriptedReader,
  type Script,
} from "../../server/tests/fake-reader.ts";
import { expect, sendFiles, test, type Rufi } from "./rufi.ts";

// Wide enough for the Documents page beside the chat panel.
test.use({ viewport: { width: 2000, height: 800 } });

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
async function documentsPage(
  page: Page,
  rufi: Rufi,
  empty = false,
  reader?: ReturnType<typeof scriptedReader>,
) {
  await rufi.family(
    ...(empty
      ? [
          `DELETE FROM record_sources; DELETE FROM results; DELETE FROM reports;
           DELETE FROM document_pages; DELETE FROM documents;`,
        ]
      : []),
  );
  await rufi.start(reader && { reader: reader.run });
  await page.goto(rufi.link());
  await page.getByRole("link", { name: "Documents" }).click();
  await expect(
    page.getByRole("heading", { name: "Documents", exact: true }),
  ).toBeVisible();
}

const chat = (page: Page) => page.getByRole("region", { name: "Chat" });
/** The chips in the box (a sent message shows its own). */
const chips = (page: Page) =>
  chat(page)
    .locator("form")
    .getByRole("list", { name: "Added to this message" })
    .getByRole("listitem");
const rows = (page: Page) =>
  page.getByRole("row").filter({ hasNot: page.getByRole("columnheader") });

/** The scripted reader's copy of a document's `count` pages. */
const copies =
  (count: number): Script =>
  async (turn) => {
    for (let number = 1; number <= count; number += 1) {
      await turn.look(number);
      await turn.save(number, readPage());
    }
    return undefined;
  };

test("Add opens the chat and the picker; photos become one document in the order chosen, and a PDF its own; they are listed once sent", async ({
  page,
  rufi,
}) => {
  await documentsPage(page, rufi, true, scriptedReader([copies(2), copies(1)]));
  await expect(page.getByText("No documents yet")).toBeVisible();
  await accessible(page);

  // One click opens the chat and the picker.
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add…" }).first().click();
  const picked = await chooser;
  await expect(
    chat(page).getByRole("textbox", { name: "Message to Rufi" }),
  ).toBeVisible();
  await picked.setFiles([
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

  // Chips in the box; the page lists nothing until they are sent.
  await expect(chips(page)).toHaveText(["2 photos", "lipid.pdf"]);
  await expect(page.getByText("No documents yet")).toBeVisible();
  await chat(page).getByRole("button", { name: "Send" }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).filter({ hasText: "IMG_2.jpg" })).toContainText(
    "+ 1 more photo",
  );
  await expect(rows(page).filter({ hasText: "lipid.pdf" })).toContainText(
    "1 page",
  );

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

test("refuses a file that isn't a document, in the chat box, and adds nothing", async ({
  page,
  rufi,
}) => {
  await documentsPage(page, rufi);
  await expect(rows(page)).toHaveCount(2);
  await page.getByLabel("Choose documents", { exact: true }).setInputFiles([
    {
      name: "notes.docx",
      mimeType: "",
      buffer: Buffer.from("Fictional notes"),
    },
  ]);
  await expect(chat(page).getByRole("alert")).toHaveText(
    "notes.docx isn't a PDF, JPEG, PNG or HEIC photo. Nothing was added. Remove it and add the others again.",
  );
  await expect(chips(page)).toHaveCount(0);
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

/** Rufi AI's sort of the file: a report on page 1, a prescription on page 2. */
const SPLIT = {
  tool: "sort_documents",
  arguments: {
    document: "$document",
    documents: [
      {
        id: "$document",
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
        reading: "$reading",
        test_name: "Haemoglobin",
        value_text: "13.2",
        unit: "g/dL",
        quote: "Haemoglobin | 13.2 | g/dL",
      },
    ],
  },
};

/** Sends the August report from the Documents page; its reader copies both pages. */
async function sendReport(page: Page, rufi: Rufi, scenario: Scenario) {
  const reader = scriptedReader([copies(2)]);
  await rufi.family(
    `DELETE FROM record_sources; DELETE FROM results; DELETE FROM reports;
     DELETE FROM document_pages; DELETE FROM documents;`,
  );
  await rufi.start({ reader: reader.run, scenario });
  await page.goto(rufi.link());
  await page.getByRole("link", { name: "Documents" }).click();
  await sendFiles(
    page,
    {
      name: "sunrise-labs-august.pdf",
      mimeType: "application/pdf",
      buffer: await readFile(join(FIXTURES, "sunrise-labs-august.pdf")),
    },
    "Sort this file",
  );
  return reader;
}

test("shows each document Rufi AI split from a file with its place in the file, kind, lab and date", async ({
  page,
  rufi,
}) => {
  await sendReport(page, rufi, {
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

test("says a file Rufi AI hasn't sorted yet, with Ask Rufi and no Retry; asking in the chat sorts it without reading again", async ({
  page,
  rufi,
}) => {
  // Rufi AI's first reply answers without sorting; the next one sorts.
  const reader = await sendReport(page, rufi, {
    callsByTurn: [[], [{ id: "sort-again", ...SPLIT }]],
  });
  const row = page
    .getByRole("row")
    .filter({ hasText: "sunrise-labs-august.pdf" });
  await expect(row.getByText("Not sorted yet")).toBeVisible();
  await expect(row.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await accessible(page);

  // The chat steps back to its bar, off the row.
  await chat(page).getByRole("button", { name: "Minimise" }).click();
  await row.hover();
  await row.getByRole("button", { name: "Ask Rufi" }).click();
  await chat(page)
    .getByRole("button", { name: /^Open the chat/ })
    .click();
  await expect(chips(page)).toHaveText(["sunrise-labs-august.pdf"]);
  await chat(page)
    .getByRole("textbox", { name: "Message to Rufi" })
    .fill("Please sort it");
  await chat(page).getByRole("button", { name: "Send" }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "page 2 of 2" }),
  ).toContainText("Prescription");
  expect(reader.runs).toHaveLength(1);
});
