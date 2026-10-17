// Deleting a document on the real core, with the fictional family: one
// with nothing saved from it goes with Delete, and an old message's chip of
// it says it was deleted; one with saved results lists them and offers
// Delete file or Delete file and results, which opens the chat where the AI
// starts. The strict CSP refuses nothing.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./rufi.ts";

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

/** Opens a document's page from the Documents page. */
async function openDocument(page: Page, name: string) {
  await page.getByRole("link", { name: "Documents" }).click();
  await page.getByRole("link", { name, exact: true }).click();
}

test("a document with nothing saved from it goes with Delete, the AI hears at once, its old chip and its open tab say so; one with saved results offers both choices, and with its results the chat opens and the AI starts", async ({
  page,
  rufi,
  context,
}) => {
  const chip = JSON.stringify([
    {
      ref: { type: "document", id: "doc-asha-aug", version: 0 },
      label: "Sunrise Labs August.pdf",
      detail: "Lab report",
    },
  ]);
  await rufi.family(
    // The August report's results were removed in the chat before.
    "UPDATE results SET removed = 1 WHERE report_id = 'rep-asha-aug';",
    `INSERT INTO transcript_entries (id, person_id, chat_id, seq, kind, text, refs, revision, created_at, updated_at)
       VALUES ('m-1', 'asha', 'c-asha', 1, 'message', 'What does this report say?', '${chip}', 1, '2026-10-05T09:00:00Z', '2026-10-05T09:00:00Z');
     UPDATE chats SET revision = 1 WHERE id = 'c-asha';`,
  );
  await rufi.start();
  await page.goto(rufi.link());

  // Nothing saved from it: one Delete. What goes, what stays, and what
  // Rufi can't reach.
  await openDocument(page, "Sunrise Labs August.pdf");
  // Another tab has it open.
  const other = await context.newPage();
  await other.goto(rufi.link());
  await other.goto(page.url());
  await expect(
    other.getByRole("button", { name: "Delete", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Delete Sunrise Labs August.pdf?" }),
  ).toBeVisible();
  await expect(dialog).toContainText("The file: 1 PDF, 2 pages");
  await expect(dialog).toContainText(
    "Its backups keep this document until they age out",
  );
  await expect(dialog.getByRole("button", { name: /^Delete/ })).toHaveText([
    "Delete",
  ]);
  await accessible(page);
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();

  await expect(page).toHaveURL(/\/documents$/);
  await expect(
    page.getByRole("link", { name: "Sunrise Labs August.pdf", exact: true }),
  ).toHaveCount(0);
  const opener = page.getByRole("button", { name: "Open the chat" });
  await opener.click();
  const messages = page.getByRole("log", { name: "Messages" });
  await expect(messages).toContainText("Deleted Sunrise Labs August.pdf");
  await expect(
    messages
      .getByRole("listitem")
      .filter({ hasText: "Sunrise Labs August.pdf" }),
  ).toContainText("document deleted");
  // The AI hears of it at once, in a reply of its own; nothing waits.
  await expect(messages.locator(".reply")).toHaveCount(1);
  await expect(
    page.getByRole("region", { name: "Waiting messages" }),
  ).toHaveCount(0);
  // The other tab, and the address opened again, say it was deleted.
  const gone = "This document was deleted.";
  await expect(other.getByText(gone)).toBeVisible();
  await other.reload();
  await expect(other.getByText(gone)).toBeVisible();
  await expect(other.getByRole("button", { name: "Retry" })).toHaveCount(0);
  // An address of no document at all doesn't say it was deleted.
  await other.goto(other.url().replace("doc-asha-aug", "doc-nobody"));
  await expect(
    other.getByText("There is no such document. It may have been deleted."),
  ).toBeVisible();
  await other.close();

  // Saved results from it: the person chooses, with no default.
  await openDocument(page, "thyroid recheck.jpg");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Delete thyroid recheck.jpg?" }),
  ).toBeVisible();
  await expect(dialog).toContainText(
    "2 results in your health record come from it:",
  );
  // The two choices say what goes and stays; the copies Rufi can't reach too.
  await expect(dialog).not.toContainText("Goes from Rufi");
  await expect(dialog).toContainText("Rufi can't reach copies outside it.");
  await expect(
    dialog
      .getByRole("list", { name: "Saved results from this document" })
      .getByRole("listitem"),
  ).toHaveText(["TSH 4.6 mIU/L12 Aug 2026", "Free T4 1.1 ng/dL1 Sep 2026"]);
  await expect(dialog.getByRole("button", { name: /^Delete/ })).toHaveText([
    "Delete file",
    "Delete file and results",
  ]);
  await expect(
    dialog.getByRole("button", { name: /^Delete/ }).first(),
  ).not.toBeFocused();
  await accessible(page);
  await dialog.getByRole("button", { name: "Delete file and results" }).click();

  // The chat opens on the Documents page, and the AI starts by itself.
  await expect(page).toHaveURL(/\/documents$/);
  await expect(messages).toContainText("Deleted thyroid recheck.jpg");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  // Nothing is removed by the delete: the results wait for the person.
  await expect(page.getByRole("link", { name: /^Lab results/ })).toContainText(
    "4",
  );
});

test("a report with many saved results keeps the dialog's buttons in view, its list scrolling", async ({
  page,
  rufi,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const many = Array.from({ length: 40 }, (_, i) => `res-m${String(i)}`);
  await rufi.family(
    `INSERT INTO results (id, person_id, report_id, category, test_name, value_text, value_number, unit, measured_at, entered_at) VALUES ${many
      .map(
        (id, i) =>
          `('${id}', 'asha', 'rep-asha-sep', 'lab', 'Test ${String(i + 1)}', '${String(i + 1)}', ${String(i + 1)}, 'U/L', '2026-09-01', '2026-09-02T18:31:00Z')`,
      )
      .join(", ")};
     INSERT INTO record_sources (person_id, kind, record_id, type, document_id, page) VALUES ${many
       .map(
         (id) =>
           `('asha', 'result', '${id}', 'document_page', 'doc-asha-sep', 1)`,
       )
       .join(", ")};`,
  );
  await rufi.start();
  await page.goto(rufi.link());
  await openDocument(page, "thyroid recheck.jpg");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const results = dialog
    .getByRole("list", { name: "Saved results from this document" })
    .getByRole("listitem");
  await expect(results).toHaveCount(42);

  await expect(
    dialog.getByRole("heading", { name: "Delete thyroid recheck.jpg?" }),
  ).toBeInViewport();
  const both = dialog.getByRole("button", { name: "Delete file and results" });
  await expect(both).toBeInViewport();
  await results.last().scrollIntoViewIfNeeded();
  await expect(results.last()).toBeInViewport();
  await expect(both).toBeInViewport();
  await accessible(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});
