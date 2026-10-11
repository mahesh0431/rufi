// The Documents page on the real core: adding files (photos as one document
// in the order chosen, a PDF on its own, the same content again, a file that
// isn't a document) and, from a document's page, the popup that shows the
// original. The strict CSP
// refuses nothing the page needs.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
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
  await page.getByRole("button", { name: "IMG_2.jpg" }).click();
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
  await page.getByRole("button", { name: "Sunrise Labs August.pdf" }).click();
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
